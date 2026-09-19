/**
 * Transport: one request, its timeout, its retry policy, and envelope decoding.
 *
 * The retry rule is the important part. Only GETs are retried. Discover and pay are
 * POSTs that create a transaction, and the API's idempotency key (`ref`) is rejected
 * on reuse rather than replayed — so a blind retry after a timeout either duplicates
 * work or fails with `DUPLICATED_REF`, and neither tells you what happened to the
 * first attempt. `bills.getByRef(ref)` does.
 *
 * The decoding rule matters nearly as much. Not every refusal comes from the
 * application: a path the router does not know, or a proxy in front of the API, answers
 * with something that is not the house envelope. Those are turned into the same typed
 * errors as everything else rather than being reported as a malformed response, because
 * "not found" is what happened and "I could not read the body" is not.
 */

import {
  BillPayAbortError,
  BillPayError,
  BillPayNetworkError,
  BillPayTimeoutError,
  errorFromEnvelope,
  errorFromHttpStatus,
} from './errors.js';
import type {
  ErrorEnvelope,
  FetchLike,
  HookContext,
  SuccessEnvelope,
  UnenvelopedError,
} from './types.js';

/** Resolved transport configuration. */
export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  retries: number;
  fetch: FetchLike;
  onRequest?: (ctx: HookContext) => void;
  onResponse?: (ctx: HookContext) => void;
}

/** A single request. */
export interface RequestSpec {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Caller cancellation, composed with the per-request timeout. */
  signal?: AbortSignal;
  /** Set for the download endpoints, which return bytes rather than an envelope. */
  raw?: boolean;
}

/** A raw (non-envelope) response, used by the receipt and avis endpoints. */
export interface RawResponse {
  /**
   * The buffer type is spelled out rather than left to default: a bare `Uint8Array` is
   * `Uint8Array<ArrayBufferLike>` from TypeScript 5.7 on, which no longer satisfies
   * `BlobPart`, and these bytes reach a browser caller as the argument to a `Blob`.
   */
  bytes: Uint8Array<ArrayBuffer>;
  headers: Headers;
  status: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BillPayAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new BillPayAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * `Retry-After` in seconds. The API sends `5`; the HTTP-date form is not used here.
 *
 * Like the other two headers this transport reads, it is invisible to a browser — not
 * safelisted, and not exposed — so in one the answer is always `undefined` and the
 * exponential fallback in {@link backoffMs} is what actually runs.
 */
const parseRetryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
};

/**
 * Filename from `Content-Disposition`, unquoted.
 *
 * Returns `undefined` far more often than the header's presence on the wire suggests:
 * `Content-Disposition` is not a CORS-safelisted response header and the API sends no
 * `Access-Control-Expose-Headers`, so in a browser this reads `null` from a response that
 * demonstrably carries the header. The download helpers therefore need a fallback that is
 * good enough to save under, not merely good enough to log.
 */
export const filenameFromDisposition = (headers: Headers): string | undefined => {
  const cd = headers.get('content-disposition');
  if (!cd) return undefined;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m?.[1];
};

/** The media types these two endpoints are documented to send, and what to call them. */
const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
};

/**
 * The extension that belongs with a `Content-Type`, or `''` when there is no honest
 * answer.
 *
 * `Content-Type` is safelisted, so it survives the CORS filter that hides
 * `Content-Disposition` — which makes it the only thing left to name a downloaded file
 * by in a browser. An extension-less file is not a cosmetic problem: Windows and macOS
 * both refuse to open one on a double-click, so a receipt saved that way looks broken to
 * the tenant who was handed it. An unrecognised type gets nothing rather than a guess.
 */
export const extensionForContentType = (contentType: string | null): string => {
  const base = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return EXTENSION_BY_TYPE[base] ?? '';
};

const buildUrl = (baseUrl: string, path: string, query?: RequestSpec['query']): string => {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
};

/**
 * The longest this transport will sleep because a server asked it to.
 *
 * `Retry-After` is a number chosen by somebody else, and obeying it without a ceiling
 * hands them control of how long the caller's own deadline means anything: a poll with a
 * two-minute budget that meets `Retry-After: 3600` sleeps for two hours inside a single
 * read. The origin sends `5`; Cloudflare sits in front of it and a rate-limit rule there
 * can name a mitigation window in minutes. Thirty seconds is far above anything the API
 * documents and far below the point at which the wait stops being a backoff.
 */
const MAX_RETRY_AFTER_MS = 30_000;

/** Backoff for GET retries: 300ms, 600ms, 1200ms… capped, unless `Retry-After` says otherwise. */
const backoffMs = (attempt: number, retryAfter?: number): number =>
  retryAfter !== undefined
    ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
    : Math.min(300 * 2 ** attempt, 5000);

/**
 * Worth another attempt on a GET: the server is struggling or throttling us, and the
 * same read will give the same answer once it stops. Every other 4xx is the caller's to
 * fix and retrying it only burns the rate limit.
 */
const isRetryableStatus = (status: number): boolean => status >= 500 || status === 429;

export class Transport {
  constructor(private readonly cfg: TransportConfig) {}

  /** Perform a request, decode the envelope, and return `data`. */
  async request<T>(spec: RequestSpec): Promise<{ data: T; envelope: SuccessEnvelope<T> }> {
    const res = await this.send(spec);
    const requestId = res.headers.get('x-request-id');
    const text = new TextDecoder().decode(res.bytes);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // A body we cannot read on a failing status is still that failure — report the
      // status, not our disappointment with the bytes.
      if (res.status >= 400) {
        throw errorFromHttpStatus({
          message: `The API returned HTTP ${res.status} with a body that was not JSON.`,
          httpStatus: res.status,
          requestId,
          retryAfter: parseRetryAfter(res.headers),
        });
      }
      throw new BillPayError('The API returned a response that was not valid JSON.', {
        code: 'INVALID_RESPONSE',
        httpStatus: res.status,
        requestId,
        cause,
      });
    }

    if (isErrorEnvelope(parsed)) {
      throw errorFromEnvelope({
        code: parsed.error.code,
        message: parsed.error.message,
        httpStatus: res.status,
        requestId: parsed.requestId ?? requestId,
        retryAfter: parseRetryAfter(res.headers),
        details: parsed.error.details,
      });
    }

    if (!isSuccessEnvelope<T>(parsed)) {
      if (res.status >= 400) throw this.unenvelopedError(parsed, res, requestId);
      throw new BillPayError('The API returned an unrecognised response envelope.', {
        code: 'INVALID_RESPONSE',
        httpStatus: res.status,
        requestId,
      });
    }

    return { data: parsed.data, envelope: parsed };
  }

  /**
   * Perform a request expecting raw bytes.
   *
   * A download that fails answers with JSON, so anything non-2xx is decoded and thrown
   * here rather than handed back as a `Uint8Array` the caller would happily write to
   * disk as a PDF.
   */
  async requestRaw(spec: RequestSpec): Promise<RawResponse> {
    const res = await this.send({ ...spec, raw: true });
    if (res.status < 400) return res;

    const requestId = res.headers.get('x-request-id');
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(res.bytes));
    } catch {
      parsed = undefined;
    }

    if (isErrorEnvelope(parsed)) {
      throw errorFromEnvelope({
        code: parsed.error.code,
        message: parsed.error.message,
        httpStatus: res.status,
        requestId: parsed.requestId ?? requestId,
        retryAfter: parseRetryAfter(res.headers),
        details: parsed.error.details,
      });
    }

    throw this.unenvelopedError(parsed, res, requestId);
  }

  /**
   * Turn a refusal that carries no house envelope into the same typed error as one that
   * does, keeping whatever sentence the server did send.
   *
   * Fastify's router miss is `{ message, error, statusCode }`; a proxy may send prose or
   * nothing at all. `GET …/{id}/avis` is documented but not yet routed in the live
   * deployment, so today it is the ordinary way to meet this path.
   */
  private unenvelopedError(
    parsed: unknown,
    res: RawResponse,
    requestId: string | null,
  ): BillPayError {
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as UnenvelopedError;
    const message =
      (typeof body.message === 'string' && body.message) ||
      (typeof body.error === 'string' && body.error) ||
      `The API answered HTTP ${res.status}.`;

    return errorFromHttpStatus({
      message,
      httpStatus: res.status,
      requestId,
      retryAfter: parseRetryAfter(res.headers),
    });
  }

  /**
   * Send with timeout and — for GET only — retries on network errors, 5xx and 429.
   *
   * A non-2xx response is returned rather than thrown; decoding turns it into a typed
   * error, because the body carries the code and the `requestId`.
   */
  private async send(spec: RequestSpec): Promise<RawResponse> {
    const url = buildUrl(this.cfg.baseUrl, spec.path, spec.query);
    const attempts = spec.method === 'GET' ? this.cfg.retries + 1 : 1;
    let lastError: BillPayError | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (spec.signal?.aborted) throw new BillPayAbortError();

      const started = Date.now();
      this.cfg.onRequest?.({ method: spec.method, path: spec.path });

      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(), this.cfg.timeoutMs);
      const onCallerAbort = (): void => timeoutCtl.abort();
      spec.signal?.addEventListener('abort', onCallerAbort, { once: true });

      try {
        const res = await this.cfg.fetch(url, {
          method: spec.method,
          headers: {
            'X-Access-Token': this.cfg.apiKey,
            Accept: spec.raw ? '*/*' : 'application/json',
            ...(spec.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
          signal: timeoutCtl.signal,
        });

        const bytes = new Uint8Array(await res.arrayBuffer());
        const out: RawResponse = { bytes, headers: res.headers, status: res.status };

        this.cfg.onResponse?.({
          method: spec.method,
          path: spec.path,
          status: res.status,
          requestId: res.headers.get('x-request-id'),
          durationMs: Date.now() - started,
        });

        const isLast = attempt === attempts - 1;
        if (isRetryableStatus(res.status) && !isLast) {
          await sleep(backoffMs(attempt, parseRetryAfter(res.headers)), spec.signal);
          continue;
        }
        return out;
      } catch (err) {
        this.cfg.onResponse?.({
          method: spec.method,
          path: spec.path,
          durationMs: Date.now() - started,
        });

        // Distinguish the caller's abort from our own timeout — they mean different things.
        if (spec.signal?.aborted) throw new BillPayAbortError();
        if (timeoutCtl.signal.aborted) {
          lastError = new BillPayTimeoutError(
            `The request timed out after ${this.cfg.timeoutMs}ms.`,
            { timeoutMs: this.cfg.timeoutMs, cause: err },
          );
        } else {
          lastError = new BillPayNetworkError('The request failed to reach the API.', {
            cause: err,
          });
        }

        if (attempt === attempts - 1) throw lastError;
        await sleep(backoffMs(attempt), spec.signal);
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onCallerAbort);
      }
    }

    /* c8 ignore next 2 — the loop always returns or throws. */
    throw lastError ?? new BillPayNetworkError('The request failed.');
  }
}

/**
 * The house error envelope. `success: false` plus a code is the whole test — a body
 * without them came from somewhere other than the application.
 */
const isErrorEnvelope = (v: unknown): v is ErrorEnvelope =>
  typeof v === 'object' &&
  v !== null &&
  (v as ErrorEnvelope).success === false &&
  typeof (v as ErrorEnvelope).error?.code === 'string';

const isSuccessEnvelope = <T>(v: unknown): v is SuccessEnvelope<T> =>
  typeof v === 'object' &&
  v !== null &&
  (v as SuccessEnvelope<T>).success === true &&
  'data' in (v as Record<string, unknown>);
