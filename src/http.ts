/**
 * Transport: one request, its timeout, its retry policy, and envelope decoding.
 *
 * The retry rule is the important part. Only GETs are retried. Discover and pay are
 * POSTs that create a transaction, and the API's idempotency key (`ref`) is rejected
 * on reuse rather than replayed — so a blind retry after a timeout either duplicates
 * work or fails with `DUPLICATED_REF`, and neither tells you what happened to the
 * first attempt. `bills.getByRef(ref)` does.
 */

import {
  BillPayAbortError,
  BillPayError,
  BillPayNetworkError,
  BillPayTimeoutError,
  errorFromEnvelope,
} from './errors.js';
import type { ErrorEnvelope, FetchLike, HookContext, SuccessEnvelope } from './types.js';

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
  /** Set for the receipt endpoint, which returns bytes rather than an envelope. */
  raw?: boolean;
}

/** A raw (non-envelope) response, used by the receipt endpoint. */
export interface RawResponse {
  bytes: Uint8Array;
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

/** `Retry-After` in seconds. The API sends `5`; the HTTP-date form is not used here. */
const parseRetryAfter = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs : undefined;
};

/** Filename from `Content-Disposition`, unquoted. */
export const filenameFromDisposition = (headers: Headers): string | undefined => {
  const cd = headers.get('content-disposition');
  if (!cd) return undefined;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m?.[1];
};

const buildUrl = (baseUrl: string, path: string, query?: RequestSpec['query']): string => {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
};

/** Backoff for GET retries: 300ms, 600ms, 1200ms… capped, unless `Retry-After` says otherwise. */
const backoffMs = (attempt: number, retryAfter?: number): number =>
  retryAfter !== undefined ? retryAfter * 1000 : Math.min(300 * 2 ** attempt, 5000);

export class Transport {
  constructor(private readonly cfg: TransportConfig) {}

  /** Perform a request, decode the envelope, and return `data`. */
  async request<T>(spec: RequestSpec): Promise<{ data: T; envelope: SuccessEnvelope<T> }> {
    const res = await this.send(spec);
    const requestId = res.headers.get('x-request-id');

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(res.bytes));
    } catch (cause) {
      throw new BillPayError('The API returned a response that was not valid JSON.', {
        code: 'INVALID_RESPONSE',
        httpStatus: res.status,
        requestId,
        cause,
      });
    }

    if (this.isErrorEnvelope(parsed)) {
      throw errorFromEnvelope({
        code: parsed.error.code,
        message: parsed.error.message,
        httpStatus: res.status,
        requestId: parsed.requestId ?? requestId,
        retryAfter: parseRetryAfter(res.headers),
        details: parsed.error.details,
      });
    }

    if (!this.isSuccessEnvelope<T>(parsed)) {
      throw new BillPayError('The API returned an unrecognised response envelope.', {
        code: 'INVALID_RESPONSE',
        httpStatus: res.status,
        requestId,
      });
    }

    return { data: parsed.data, envelope: parsed };
  }

  /** Perform a request expecting raw bytes; errors still arrive as an envelope. */
  async requestRaw(spec: RequestSpec): Promise<RawResponse> {
    const res = await this.send({ ...spec, raw: true });
    const contentType = res.headers.get('content-type') ?? '';

    // A failed receipt download still returns the house JSON envelope.
    if (contentType.includes('application/json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(res.bytes));
      } catch {
        parsed = null;
      }
      if (this.isErrorEnvelope(parsed)) {
        throw errorFromEnvelope({
          code: parsed.error.code,
          message: parsed.error.message,
          httpStatus: res.status,
          requestId: parsed.requestId ?? res.headers.get('x-request-id'),
          retryAfter: parseRetryAfter(res.headers),
          details: parsed.error.details,
        });
      }
    }
    return res;
  }

  /**
   * Send with timeout and — for GET only — retries on network errors and 5xx.
   *
   * A non-2xx response is returned rather than thrown; decoding turns it into a typed
   * error, because the envelope carries the code and the `requestId`.
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

        // Retry 5xx on GET only; 4xx is the caller's to fix and never retried.
        const isLast = attempt === attempts - 1;
        if (res.status >= 500 && !isLast) {
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

  private isErrorEnvelope(v: unknown): v is ErrorEnvelope {
    return (
      typeof v === 'object' &&
      v !== null &&
      (v as ErrorEnvelope).success === false &&
      typeof (v as ErrorEnvelope).error?.code === 'string'
    );
  }

  private isSuccessEnvelope<T>(v: unknown): v is SuccessEnvelope<T> {
    return (
      typeof v === 'object' &&
      v !== null &&
      (v as SuccessEnvelope<T>).success === true &&
      'data' in (v as Record<string, unknown>)
    );
  }
}
