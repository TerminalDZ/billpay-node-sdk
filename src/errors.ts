/**
 * Typed errors.
 *
 * The SDK never throws a bare `Error`, and never puts the API key in a message, a
 * property or a stack — callers routinely log these objects wholesale.
 */

import type { SyncErrorCode, TransactionStatus } from './types.js';

/**
 * Base class for everything this SDK throws.
 *
 * Catch this to handle any SDK failure; catch a subclass to branch on a category.
 * `code` is the API's error code where one was returned, or an SDK-local code
 * (`TIMEOUT`, `NETWORK`, `ABORTED`, `POLL_TIMEOUT`) where the failure was local.
 */
export class BillPayError extends Error {
  /** API error code, or an SDK-local one for transport failures. */
  readonly code: string;
  /** HTTP status, or `undefined` when the request never got a response. */
  readonly httpStatus?: number;
  /** Correlation id. Quote this when contacting support. */
  readonly requestId?: string | null;
  /** Seconds from `Retry-After`, when the server sent one. */
  readonly retryAfter?: number;
  /** `error.details` from the envelope, when present. */
  readonly details?: unknown;

  constructor(
    message: string,
    opts: {
      code: string;
      httpStatus?: number;
      requestId?: string | null;
      retryAfter?: number;
      details?: unknown;
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
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * Whether retrying the *same* request could plausibly succeed.
   *
   * True for the transient categories only. This describes the error, not the
   * request: a POST is never safe to retry blindly whatever this says — recover with
   * `bills.getByRef(...)` instead.
   */
  get isRetryable(): boolean {
    return (
      this instanceof BillPayUnavailableError ||
      this instanceof BillPayNetworkError ||
      this instanceof BillPayTimeoutError ||
      (this.httpStatus !== undefined && this.httpStatus >= 500)
    );
  }
}

/**
 * `401 MISSING_ACCESS_TOKEN` · `401 INVALID_ACCESS_TOKEN`.
 *
 * Note that `503 AUTH_UNAVAILABLE` is **not** here — it means the API could not reach
 * its auth service in time, which says nothing about your key. It maps to
 * {@link BillPayUnavailableError}.
 */
export class BillPayAuthError extends BillPayError {}

/** `400 ERR_VALIDATION` · `400 INVALID_ACCOUNT` · `413 PAYLOAD_TOO_LARGE`. */
export class BillPayValidationError extends BillPayError {}

/**
 * `403 DUPLICATED_REF` · `409 BILL_ALREADY_PAID` · `409 PAYMENT_IN_PROGRESS`.
 *
 * A `DUPLICATED_REF` on pay usually means the discovery ref was reused — the pay ref
 * must differ, because the discovery transaction is still live.
 */
export class BillPayConflictError extends BillPayError {}

/**
 * `503 AUTH_UNAVAILABLE` · `503 SERVICE_UNAVAILABLE` · `503 PARTNER_UNAVAILABLE`.
 *
 * All three carry `Retry-After: 5`, surfaced as {@link BillPayError.retryAfter}.
 */
export class BillPayUnavailableError extends BillPayError {}

/**
 * `404 NOT_FOUND`.
 *
 * A transaction belonging to another partner returns 404, not 403 — the API does not
 * confirm that someone else's id exists.
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
 */
export class BillPayPollTimeoutError extends BillPayError {
  readonly transactionId: string;
  readonly lastStatus?: TransactionStatus;

  constructor(
    message: string,
    opts: { transactionId: string; lastStatus?: TransactionStatus; requestId?: string | null },
  ) {
    super(message, { code: 'POLL_TIMEOUT', requestId: opts.requestId });
    this.transactionId = opts.transactionId;
    this.lastStatus = opts.lastStatus;
  }
}

/** Maps each synchronous API code to the class a caller branches on. */
const CODE_TO_CLASS: Record<SyncErrorCode, typeof BillPayError> = {
  MISSING_ACCESS_TOKEN: BillPayAuthError,
  INVALID_ACCESS_TOKEN: BillPayAuthError,
  AUTH_UNAVAILABLE: BillPayUnavailableError,
  SERVICE_UNAVAILABLE: BillPayUnavailableError,
  PARTNER_UNAVAILABLE: BillPayUnavailableError,
  DUPLICATED_REF: BillPayConflictError,
  BILL_ALREADY_PAID: BillPayConflictError,
  PAYMENT_IN_PROGRESS: BillPayConflictError,
  ERR_VALIDATION: BillPayValidationError,
  INVALID_ACCOUNT: BillPayValidationError,
  PAYLOAD_TOO_LARGE: BillPayValidationError,
  NOT_FOUND: BillPayNotFoundError,
  INTERNAL_ERROR: BillPayInternalError,
};

/** Fallback when a code is unrecognised: pick a class from the HTTP status. */
const statusToClass = (status: number): typeof BillPayError => {
  if (status === 401) return BillPayAuthError;
  if (status === 404) return BillPayNotFoundError;
  if (status === 403 || status === 409) return BillPayConflictError;
  if (status === 400 || status === 413 || status === 422) return BillPayValidationError;
  if (status === 503) return BillPayUnavailableError;
  if (status >= 500) return BillPayInternalError;
  return BillPayError;
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
    CODE_TO_CLASS[opts.code as SyncErrorCode] ?? statusToClass(opts.httpStatus);
  return new Cls(opts.message, {
    code: opts.code,
    httpStatus: opts.httpStatus,
    requestId: opts.requestId,
    retryAfter: opts.retryAfter,
    details: opts.details,
  });
};
