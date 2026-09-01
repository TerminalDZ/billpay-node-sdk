/**
 * Wire types for the OneClickDz Bill Payment API (`/v3`).
 *
 * Written by hand against billPayManager's source, not generated from `openapi.yaml`.
 * The published spec disagrees with the implementation in several places (see README
 * "Known drift"); where they differ, the code wins and these types follow the code.
 */

// ─── Partners ─────────────────────────────────────────────────────────────────

/**
 * The five supported billing partners.
 *
 * `'Algérie Télécom'` carries its accents — it is the literal value the API compares
 * against, not a slug. Sending `'Algerie Telecom'` is rejected as `ERR_VALIDATION`.
 */
export type Partner = 'ADE' | 'SONELGAZ' | 'SEAAL' | 'AADL' | 'Algérie Télécom';

/** All partners, in the order the API enumerates them. */
export const PARTNERS: readonly Partner[] = [
  'ADE',
  'AADL',
  'SONELGAZ',
  'SEAAL',
  'Algérie Télécom',
] as const;

/** Availability of a single partner. */
export type PartnerStatus = 'ACTIVE' | 'UNAVAILABLE';

/** The `GET /v3/partners` payload: one entry per partner. */
export type PartnersMap = Record<string, { status: PartnerStatus }>;

// ─── Account identifiers ──────────────────────────────────────────────────────

/**
 * An account identifier carries **exactly one** field. Zero, or more than one, is
 * rejected — `ERR_VALIDATION` from the Joi layer or `INVALID_ACCOUNT` from the
 * controller, depending on which notices first.
 *
 * The union below makes a wrong combination a compile-time error. Each member is
 * "one field, plus every other field explicitly `never`", which is what stops
 * TypeScript from silently accepting an object with two identifiers.
 *
 * Responses always echo the camelCase form, keyed by partner:
 * `reference` (ADE, SEAAL) · `contractNumber` (SONELGAZ) · `aadlNumber` (AADL) ·
 * `phoneNumber` (Algérie Télécom).
 */
export type AccountIdentifier =
  | ReferenceAccount
  | ContractNumberAccount
  | AadlNumberAccount
  | PhoneNumberAccount
  | ElectronicPaymentKeyAccount
  | PhoneNumberSnakeAccount
  | SonelgazInvoiceAccount
  | AdeInvoiceAccount;

/** Only the listed key may be present; the rest are pinned to `never`. */
type Only<K extends string> = { [P in Exclude<AccountKey, K>]?: never };

type AccountKey =
  | 'reference'
  | 'contractNumber'
  | 'aadlNumber'
  | 'phoneNumber'
  | 'electronic_payment_key'
  | 'phone_number'
  | 'sonelgaz'
  | 'ade';

/** ADE and SEAAL. Max 50 characters. */
export type ReferenceAccount = { reference: string } & Only<'reference'>;

/** SONELGAZ. Max 50 characters. */
export type ContractNumberAccount = { contractNumber: string } & Only<'contractNumber'>;

/** AADL. Max 50 characters. */
export type AadlNumberAccount = { aadlNumber: string } & Only<'aadlNumber'>;

/** Algérie Télécom. Algerian landline: `^(0|\+213)[2-4][0-9]{7}$`. */
export type PhoneNumberAccount = { phoneNumber: string } & Only<'phoneNumber'>;

/** Internal snake_case form. Exactly 25 characters — not "up to", exactly. */
export type ElectronicPaymentKeyAccount = { electronic_payment_key: string } &
  Only<'electronic_payment_key'>;

/** Internal snake_case form of {@link PhoneNumberAccount}. */
export type PhoneNumberSnakeAccount = { phone_number: string } & Only<'phone_number'>;

/** SONELGAZ nested invoice form. All three fields required. */
export type SonelgazInvoiceAccount = {
  sonelgaz: { invoice_number: string; amount_without_stamp: string; ebb_key: string };
} & Only<'sonelgaz'>;

/** ADE nested invoice form. All four fields required; `period` is `MM/YYYY`. */
export type AdeInvoiceAccount = {
  ade: { sub_id: string; period: string; amount: string; pay_key: string };
} & Only<'ade'>;

// ─── Statuses ─────────────────────────────────────────────────────────────────

/**
 * The seven partner-facing statuses.
 *
 * `READY` means discovery finished — read `bills`. An empty array means nothing is
 * payable, which also covers "everything owed is under the 200 DZD discovery floor".
 *
 * `UNKNOWN` means the outcome is under review. It is **not** a failure and **not**
 * terminal: it resolves to `SUCCESS` or `REFUNDED`. Never branch on it as either.
 */
export type TransactionStatus =
  | 'PENDING'
  | 'READY'
  | 'PROCESSING'
  | 'UNKNOWN'
  | 'SUCCESS'
  | 'FAILED'
  | 'REFUNDED';

/** The three statuses a transaction never leaves. `UNKNOWN` is deliberately absent. */
export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'REFUNDED'] as const;

/** A status a transaction never leaves. */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Narrowing guard for {@link TerminalStatus}. `UNKNOWN` returns `false`. */
export const isTerminal = (s: TransactionStatus): s is TerminalStatus =>
  (TERMINAL_STATUSES as readonly string[]).includes(s);

// ─── Error codes ──────────────────────────────────────────────────────────────

/** Every synchronous error code the API can return. There are thirteen. */
export type SyncErrorCode =
  | 'MISSING_ACCESS_TOKEN'
  | 'INVALID_ACCESS_TOKEN'
  | 'AUTH_UNAVAILABLE'
  | 'DUPLICATED_REF'
  | 'ERR_VALIDATION'
  | 'INVALID_ACCOUNT'
  | 'BILL_ALREADY_PAID'
  | 'PAYMENT_IN_PROGRESS'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'PARTNER_UNAVAILABLE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

/**
 * The four reasons that appear inside a transaction's `error`, and only when the
 * status is `FAILED` or `REFUNDED`.
 *
 * `NO_BILLS_FOUND` appears in `openapi.yaml` but is never emitted — a discovery that
 * finds nothing is reported as `READY` with `bills: []`, not as an error.
 */
export type TerminalErrorCode =
  | 'PAYMENT_DECLINED'
  | 'PARTNER_UNAVAILABLE'
  | 'INVALID_ACCOUNT'
  | 'BILL_ALREADY_PAID';

// ─── Envelope ─────────────────────────────────────────────────────────────────

/** `meta` on a success envelope. Pagination fields appear on list responses only. */
export interface ResponseMeta {
  timestamp: string;
  total?: number;
  limit?: number;
  offset?: number;
}

/** The success envelope. Every endpoint except receipt download returns this. */
export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
  requestId: string;
}

/** The error envelope. Receipt download uses this too when it fails. */
export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId: string;
}

// ─── Resources ────────────────────────────────────────────────────────────────

/** `GET /v3/validate`. */
export interface ValidateResult {
  account: { id: string; status: string; currency: string };
  key: { type: 'SANDBOX' | 'PRODUCTION' };
}

/** One payable bill. `fee` is already included in `Transaction.total` when selected. */
export interface Bill {
  billId: string;
  amount: number;
  fee: number;
  label?: string;
  period?: string;
}

/**
 * A transaction, as returned by `get`, `getByRef` and `list`.
 *
 * Beware: `list` does not populate `bills` or `error` — see {@link BillsResource.list}.
 * Read a specific transaction with `get` before acting on either field.
 */
export interface Transaction {
  transactionId: string;
  /** Always the **discovery** ref, never the ref passed to `pay`. */
  ref?: string;
  type: 'discovery' | 'payment';
  status: TransactionStatus;
  partner: string;
  account: Record<string, string>;
  currency: string;
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp once terminal, otherwise `null`. */
  completedAt: string | null;
  /** Present when `status === 'READY'`. Empty array means nothing payable. */
  bills?: Bill[];
  selectedBill?: Bill;
  /** `selectedBill.amount + selectedBill.fee`, present once a bill is selected. */
  total?: number;
  /**
   * Set on **every** `SUCCESS`, even when no bytes exist for it — so the download
   * behind it can still 404. Never treat its presence as a promise.
   */
  receiptUrl?: string;
  operationId?: string;
  /** Present only when `status` is `FAILED` or `REFUNDED`. */
  error?: { code: TerminalErrorCode; message: string };
}

/** `POST /v3/bills/discover` acknowledgement. Not an outcome — poll for that. */
export interface DiscoverAck {
  transactionId: string;
  ref: string;
  status: 'PENDING';
}

/**
 * `POST /v3/bills/pay` acknowledgement. Not an outcome — poll for that.
 *
 * `ref` echoes the **discovery** ref, not the ref you passed in. The pay ref is
 * validated and then discarded.
 */
export interface PayAck {
  transactionId: string;
  ref?: string;
  status: 'PROCESSING';
}

// ─── Request shapes ───────────────────────────────────────────────────────────

/** `POST /v3/bills/discover`. */
export interface DiscoverParams {
  partner: Partner;
  account: AccountIdentifier;
  /** Required. Max 100 characters. Unique per (account, partner). */
  ref: string;
}

/** `POST /v3/bills/pay`. */
export interface PayParams {
  /** 24-character lowercase hex. Anything else is rejected by `paySchema`. */
  transactionId: string;
  billId: string;
  /**
   * Required, max 100 characters, and it **must differ from the discovery ref** —
   * that transaction is still live, so reusing its ref is a clash.
   *
   * The value is validated and then thrown away: the transaction keeps its discovery
   * ref, so a later `getByRef` with this value returns 404. Use
   * {@link BillsResource.getByRef} with the *discovery* ref to recover.
   */
  ref: string;
}

/** `GET /v3/bills/transactions`. */
export interface ListParams {
  status?: TransactionStatus;
  partner?: Partner;
  /** ISO-8601 date string. */
  from?: string;
  /** ISO-8601 date string. */
  to?: string;
  /** 1–100. Defaults to 20 server-side. */
  limit?: number;
  /** ≥ 0. Defaults to 0 server-side. */
  offset?: number;
}

/** `GET /v3/bills/transactions/by-ref`. */
export interface GetByRefParams {
  /** The **discovery** ref. */
  ref: string;
  /** Narrows the lookup. Without it the ref must be unique across your partners. */
  partner?: Partner;
}

/** A paginated list result. Counts come from `meta`, not the body. */
export interface TransactionList {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

/** A downloaded receipt. */
export interface Receipt {
  bytes: Uint8Array;
  /** `application/pdf`, `image/png`, `image/jpeg` or `application/octet-stream`. */
  contentType: string;
  /** Parsed from `Content-Disposition`; falls back to `receipt-<transactionId>`. */
  filename: string;
  requestId: string | null;
}

// ─── Client configuration ─────────────────────────────────────────────────────

/** What a request/response hook is told. Never headers, never the API key. */
export interface HookContext {
  method: string;
  path: string;
  status?: number;
  requestId?: string | null;
  /** Wall-clock duration in ms. Present on `onResponse` only. */
  durationMs?: number;
}

/** A `fetch` implementation. Injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** {@link BillPayClient} options. */
export interface BillPayClientOptions {
  /** Partner key, sent as `X-Access-Token`. */
  apiKey: string;
  /** Defaults to `https://billapi.oneclickdz.com`. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 15000. */
  timeoutMs?: number;
  /** Extra attempts for **GET only**. Defaults to 2. POSTs are never retried. */
  retries?: number;
  /** Inject a `fetch` for testing. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Called before each attempt. */
  onRequest?: (ctx: HookContext) => void;
  /** Called after each attempt, including failed ones. */
  onResponse?: (ctx: HookContext) => void;
}

/** Options common to the polling helpers. */
export interface PollOptions {
  /** Give up after this long. Defaults to 120000. */
  timeoutMs?: number;
  /** First delay between polls. Backs off to `maxIntervalMs`. Defaults to 1000. */
  intervalMs?: number;
  /** Backoff ceiling. Defaults to 5000. */
  maxIntervalMs?: number;
  /** Cancel the wait. Rejects with {@link BillPayAbortError}. */
  signal?: AbortSignal;
}
