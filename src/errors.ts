/**
 * Typed errors.
 *
 * The SDK never throws a bare `Error`, and never puts the API key in a message, a
 * property or a stack — callers routinely log these objects wholesale.
 */

import type { KeyErrorCode, SyncErrorCode, TransactionStatus } from './types.js';

/**
 * Base class for everything this SDK throws.
 *
 * Catch this to handle any SDK failure; catch a subclass to branch on a category.
 * `code` is the API's error code where one was returned, an SDK-local code
 * (`TIMEOUT`, `NETWORK`, `ABORTED`, `POLL_TIMEOUT`, `INVALID_RESPONSE`) where the
 * failure was local, or `HTTP_<status>` where the server refused us without sending a
 * code of its own — a shape you get from the router rather than from the application.
 * Branch on `code` or on the class, never on `message`.
 */
export class BillPayError extends Error {
  /** API error code, or an SDK-local one for transport failures. */
  readonly code: string;
  /** HTTP status, or `undefined` when the request never got a response. */
  readonly httpStatus?: number;
  /** Correlation id. Quote this when contacting support. */
  readonly requestId?: string | null;
  /**
   * Seconds from `Retry-After`, when the server sent one.
   *
   * In practice only `AUTH_UNAVAILABLE` and a rate limit carry it. The other 503s do
   * not, so an absent value means "back off on your own schedule", not "retry now".
   */
  readonly retryAfter?: number;
  /** `error.details` from the envelope, when present. */
  readonly details?: unknown;
  /**
   * Whether the refusal carried the house envelope — that is, whether it came from the
   * application or merely from the router in front of it.
   *
   * `true` for anything the API itself decided, which is almost everything. `false`
   * when the request was turned away before it reached the application: an unknown
   * path, a proxy, a gateway. See {@link isEndpointMissing}, which is the useful
   * reading of it.
   *
   * Local failures — a timeout, an aborted call, a dropped socket — never reached a
   * server at all and are reported as `false`.
   */
  readonly enveloped: boolean;

  constructor(
    message: string,
    opts: {
      code: string;
      httpStatus?: number;
      requestId?: string | null;
      retryAfter?: number;
      details?: unknown;
      enveloped?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.requestId = opts.requestId;
    this.retryAfter = opts.retryAfter;
    this.details = opts.details;
    this.enveloped = opts.enveloped ?? false;
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * Whether this deployment does not serve the endpoint at all.
   *
   * A `404` that never reached the application is the router saying "no such path",
   * which is a different fact from the application saying "no such thing" — and the two
   * are otherwise indistinguishable, because both arrive as `NOT_FOUND`.
   *
   * The distinction is live today on {@link BillsResource.avis}: the endpoint is
   * documented and implemented here, but is not yet routed in the deployment, so it
   * answers a router miss. Branch on this and your code needs no edit the day it ships —
   * `true` means "not available here yet, try again later", while a `NOT_FOUND` with
   * this `false` is the real answer: the transaction is not yours, is not AADL, or has
   * not resolved a housing file.
   *
   * ```ts
   * try {
   *   const avis = await client.bills.avis(transactionId);
   * } catch (err) {
   *   if (err instanceof BillPayNotFoundError && err.isEndpointMissing) {
   *     // Not deployed yet. Offer the receipt instead and check again another day.
   *   } else if (err instanceof BillPayNotFoundError) {
   *     // Deployed, and it has told you something: wrong partner, or no avis yet.
   *   }
   * }
   * ```
   */
  get isEndpointMissing(): boolean {
    return this.httpStatus === 404 && !this.enveloped;
  }

  /**
   * Whether retrying the *same* request could plausibly succeed.
   *
   * True for the transient categories only. This describes the error, not the
   * request: a POST is never safe to retry blindly whatever this says — recover with
   * `bills.getByRef(...)` instead.
   *
   * `SERVICE_UNAVAILABLE` is the trap. It is transient, so this returns `true`, but it
   * means the bill service did not answer *in time*, not that nothing happened: on a
   * pay, the payment may well be running. Read the transaction before you resend it.
   */
  get isRetryable(): boolean {
    return (
      this instanceof BillPayUnavailableError ||
      this instanceof BillPayRateLimitError ||
      this instanceof BillPayNetworkError ||
      this instanceof BillPayTimeoutError ||
      (this.httpStatus !== undefined && this.httpStatus >= 500)
    );
  }
}

/**
 * The key was refused: `401 MISSING_ACCESS_TOKEN` · `401 INVALID_ACCESS_TOKEN` ·
 * `401 ERR_AUTH` · `403 IP_BLOCKED` · `403 IP_NOT_ALLOWED` · `403 API_DISABLED`.
 *
 * The three 403s are here rather than under {@link BillPayConflictError} because they say
 * something about your key — where it may be used, and whether it is switched on — not
 * about the request. None is worth a retry; the first clears itself and the other two
 * need a change in the dashboard.
 *
 * Note that `503 AUTH_UNAVAILABLE` is **not** here — it means the API could not reach
 * its auth service in time, which says nothing about your key. It maps to
 * {@link BillPayUnavailableError}. Rotating a key in response to it is the reflex to
 * resist: it costs an outage and fixes nothing.
 *
 * Repeated rejections are counted. The API locks a key out after twenty consecutive
 * bad attempts, and the message tells you how many are left — so never loop over
 * candidate keys to find the working one. Spend them all and the next answer is
 * `IP_BLOCKED`: your address, not your key, is what stops being served, for about
 * fifteen minutes. That one is an alert to wake somebody with, not a thing to poll.
 */
export class BillPayAuthError extends BillPayError {}

/**
 * The request was malformed or the identifier unusable: `400 ERR_VALIDATION` ·
 * `400 INVALID_ACCOUNT` · `413 PAYLOAD_TOO_LARGE`.
 *
 * The two 400s want opposite handling. `ERR_VALIDATION` is your integration's bug —
 * log it with `details`, which lists every offending field, and never show it to the
 * customer. `INVALID_ACCOUNT` is the customer mistyping their reference — show that
 * one, and let them correct it.
 */
export class BillPayValidationError extends BillPayError {}

/**
 * The work is already done or already running: `403 DUPLICATED_REF` ·
 * `409 BILL_ALREADY_PAID` · `409 PAYMENT_IN_PROGRESS`.
 *
 * None of the three is a reason to resend with a different ref. Each one means there is
 * an existing transaction that answers your question — look it up with `getByRef` or
 * `list` and read its status instead.
 */
export class BillPayConflictError extends BillPayError {}

/**
 * Something upstream is down: `503 AUTH_UNAVAILABLE` · `503 SERVICE_UNAVAILABLE` ·
 * `503 PARTNER_UNAVAILABLE`.
 *
 * Only `AUTH_UNAVAILABLE` sends `Retry-After: 5`, surfaced as
 * {@link BillPayError.retryAfter}; for the other two you choose your own backoff. They
 * also differ in what they promise: `PARTNER_UNAVAILABLE` and `AUTH_UNAVAILABLE` mean
 * nothing was started, while `SERVICE_UNAVAILABLE` means the outcome is unknown.
 */
export class BillPayUnavailableError extends BillPayError {}

/**
 * `429 RATE_LIMIT_EXCEEDED` — too many requests for this key.
 *
 * The published ceilings are 60 requests a minute in sandbox and 120 in production.
 * Honour {@link BillPayError.retryAfter} when it is set; the transport already does for
 * the GETs it retries, capped so that a very large value cannot turn one read into a
 * wait measured in hours.
 *
 * In a browser it is never set. `Retry-After` is not a CORS-safelisted response header
 * and the API exposes none, so `Headers.get` reads `null` from a response that carries
 * it and the transport falls back to its own exponential backoff. An absent value has
 * always meant "back off on your own schedule" rather than "retry now", so an app that
 * already reads it that way loses nothing but precision.
 */
export class BillPayRateLimitError extends BillPayError {}

/**
 * `404 NOT_FOUND`.
 *
 * A transaction belonging to another partner — or to the other environment — returns
 * 404, not 403, by design: the API never confirms that someone else's id exists. Read
 * it as "check the identifier and the key", never as "access denied".
 */
export class BillPayNotFoundError extends BillPayError {}

/** `500 INTERNAL_ERROR`, and any unmapped 5xx. */
export class BillPayInternalError extends BillPayError {}

/** The request exceeded `timeoutMs`. */
export class BillPayTimeoutError extends BillPayError {
  constructor(message: string, opts: { timeoutMs: number; cause?: unknown }) {
    super(message, { code: 'TIMEOUT', cause: opts.cause });
  }
}

/** A transport-level failure: DNS, connection refused, socket reset. */
export class BillPayNetworkError extends BillPayError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, { code: 'NETWORK', cause: opts.cause });
  }
}

/** The caller's `AbortSignal` fired. */
export class BillPayAbortError extends BillPayError {
  constructor(message = 'The operation was aborted.') {
    super(message, { code: 'ABORTED' });
  }
}

/**
 * A polling helper hit its `timeoutMs` before reaching the state it waited for.
 *
 * The transaction is untouched and probably still progressing — read
 * {@link lastStatus} and keep polling if you want to.
 *
 * This is also what you get when the *reads* were what failed. A poller rides out
 * transient refusals rather than abandoning a payment over them, so a run that never
 * managed a successful read still ends here, with `lastStatus` undefined and the last
 * refusal as `cause`. Both endings mean the same thing to your order state — nobody
 * knows yet — which is why they are one error and not two.
 */
export class BillPayPollTimeoutError extends BillPayError {
  readonly transactionId: string;
  readonly lastStatus?: TransactionStatus;

  constructor(
    message: string,
    opts: {
      transactionId: string;
      lastStatus?: TransactionStatus;
      requestId?: string | null;
      /** The last read failure, when transient refusals are what used up the budget. */
      cause?: unknown;
    },
  ) {
    super(message, { code: 'POLL_TIMEOUT', requestId: opts.requestId, cause: opts.cause });
    this.transactionId = opts.transactionId;
    this.lastStatus = opts.lastStatus;
  }
}

/** Maps each API code — Bill Payment's own and the key layer's — to a catchable class. */
const CODE_TO_CLASS: Record<SyncErrorCode | KeyErrorCode, typeof BillPayError> = {
  MISSING_ACCESS_TOKEN: BillPayAuthError,
  INVALID_ACCESS_TOKEN: BillPayAuthError,
  ERR_AUTH: BillPayAuthError,
  IP_BLOCKED: BillPayAuthError,
  IP_NOT_ALLOWED: BillPayAuthError,
  API_DISABLED: BillPayAuthError,
  AUTH_UNAVAILABLE: BillPayUnavailableError,
  SERVICE_UNAVAILABLE: BillPayUnavailableError,
  PARTNER_UNAVAILABLE: BillPayUnavailableError,
  RATE_LIMIT_EXCEEDED: BillPayRateLimitError,
  DUPLICATED_REF: BillPayConflictError,
  BILL_ALREADY_PAID: BillPayConflictError,
  PAYMENT_IN_PROGRESS: BillPayConflictError,
  ERR_VALIDATION: BillPayValidationError,
  INVALID_ACCOUNT: BillPayValidationError,
  PAYLOAD_TOO_LARGE: BillPayValidationError,
  NOT_FOUND: BillPayNotFoundError,
  INTERNAL_ERROR: BillPayInternalError,
};

/** Fallback when a code is unrecognised or absent: pick a class from the HTTP status. */
const statusToClass = (status: number): typeof BillPayError => {
  if (status === 401) return BillPayAuthError;
  if (status === 404) return BillPayNotFoundError;
  if (status === 403 || status === 409) return BillPayConflictError;
  if (status === 400 || status === 413 || status === 422) return BillPayValidationError;
  if (status === 429) return BillPayRateLimitError;
  if (status === 503) return BillPayUnavailableError;
  if (status >= 500) return BillPayInternalError;
  return BillPayError;
};

/**
 * The code to use when the server refused us without sending one.
 *
 * Only statuses that map to exactly one documented code are translated. Everything else
 * becomes `HTTP_<status>`, which is deliberately not a code the API can send: a caller
 * comparing `code` can always tell a value the server chose from one the SDK inferred
 * on its behalf.
 */
const STATUS_TO_CODE: Readonly<Record<number, SyncErrorCode | KeyErrorCode>> = {
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Build the right error subclass from a decoded error envelope.
 *
 * An unknown code is not an error in itself — the API may add codes — so it falls back
 * to the HTTP status and keeps the code verbatim.
 */
export const errorFromEnvelope = (opts: {
  code: string;
  message: string;
  httpStatus: number;
  requestId?: string | null;
  retryAfter?: number;
  details?: unknown;
}): BillPayError => {
  const Cls =
    CODE_TO_CLASS[opts.code as SyncErrorCode | KeyErrorCode] ?? statusToClass(opts.httpStatus);
  return new Cls(opts.message, {
    code: opts.code,
    httpStatus: opts.httpStatus,
    requestId: opts.requestId,
    retryAfter: opts.retryAfter,
    details: opts.details,
    // This one came out of the house envelope, so the application answered it.
    enveloped: true,
  });
};

/**
 * Build an error from an HTTP status alone, for a refusal that never reached the
 * application and so carries no house envelope.
 *
 * Fastify answers an unknown path with `{ message, error, statusCode }` and no
 * `success` field; a proxy or a load balancer in front of the API can answer with no
 * JSON at all. Both are ordinary failures from the caller's seat — a `404` on a path
 * that is documented but not yet deployed should surface as
 * {@link BillPayNotFoundError}, exactly like a `404` on a transaction that does not
 * exist, not as a decoding complaint about a response nobody asked them to read.
 *
 * The server's own sentence is kept as the message whenever there is one, because it is
 * usually the most specific thing anyone will ever tell you about the failure.
 */
export const errorFromHttpStatus = (opts: {
  message: string;
  httpStatus: number;
  requestId?: string | null;
  retryAfter?: number;
  details?: unknown;
}): BillPayError => {
  const Cls = statusToClass(opts.httpStatus);
  return new Cls(opts.message, {
    code: STATUS_TO_CODE[opts.httpStatus] ?? `HTTP_${opts.httpStatus}`,
    httpStatus: opts.httpStatus,
    requestId: opts.requestId,
    retryAfter: opts.retryAfter,
    details: opts.details,
  });
};
