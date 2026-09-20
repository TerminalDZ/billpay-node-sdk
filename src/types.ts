/**
 * Wire types for the OneClickDz Bill Payment API (`/v3`).
 */

// ─── Partners ─────────────────────────────────────────────────────────────────

/** The five supported billers. `'Algérie Télécom'` is compared literally, accents included. */
export type Partner = 'ADE' | 'SONELGAZ' | 'SEAAL' | 'AADL' | 'Algérie Télécom';

/** All partners, in the order the API enumerates them. */
export const PARTNERS: readonly Partner[] = [
  'ADE',
  'AADL',
  'SONELGAZ',
  'SEAAL',
  'Algérie Télécom',
] as const;

/** Availability of one partner. `UNAVAILABLE` answers `503 PARTNER_UNAVAILABLE` on discover and pay. */
export type PartnerStatus = 'ACTIVE' | 'UNAVAILABLE';

/** `GET /v3/bills/partners`: one entry per partner. Read it at runtime; availability changes without notice. */
export type PartnersMap = Record<string, { status: PartnerStatus }>;

// ─── Account identifiers ──────────────────────────────────────────────────────

/**
 * The account to discover. Exactly one identifier, in the shape the partner expects:
 *
 * | Partner           | Identifier                                                       |
 * | ----------------- | ---------------------------------------------------------------- |
 * | `ADE`             | `{ electronic_payment_key }` — 25 characters                     |
 * | `SONELGAZ`        | `{ sonelgaz: { invoice_number, amount_without_stamp, ebb_key } }` |
 * | `SEAAL`           | `{ seaal: { code_client, code_contrat } }`                       |
 * | `AADL`            | `{ aadl: { codeloc } }` — 6–20 digits                            |
 * | `Algérie Télécom` | `{ phone_number }` — landline, `0[2-4]` + 7 digits               |
 *
 * Each member pins the other keys to `never`, so two identifiers are a compile error.
 * Responses echo the identifier flat under a partner-specific key (see {@link Transaction.account}).
 */
export type AccountIdentifier =
  ElectronicPaymentKeyAccount | PhoneNumberAccount | SonelgazAccount | AadlAccount | SeaalAccount;

type AccountKey = 'electronic_payment_key' | 'phone_number' | 'sonelgaz' | 'aadl' | 'seaal';

/** Only the listed key may be present; the rest are pinned to `never`. */
type Only<K extends AccountKey> = { [P in Exclude<AccountKey, K>]?: never };

/** ADE — the clé de paiement électronique printed on the bill. Exactly 25 characters. */
export type ElectronicPaymentKeyAccount = {
  electronic_payment_key: string;
} & Only<'electronic_payment_key'>;

/** Algérie Télécom — a landline in local form (`023456789`), never a mobile number or E.164. */
export type PhoneNumberAccount = { phone_number: string } & Only<'phone_number'>;

/**
 * SONELGAZ — the three values printed on the bill. All required, as strings;
 * `amount_without_stamp` uses a dot as decimal separator (`"28491.72"`). The portal
 * validates the three together.
 */
export type SonelgazAccount = {
  sonelgaz: { invoice_number: string; amount_without_stamp: string; ebb_key: string };
} & Only<'sonelgaz'>;

/**
 * AADL — `codeloc`, the housing file number (6–20 digits). AADL issues one aggregate
 * notice per file; arrears are included in it and cannot be paid separately.
 */
export type AadlAccount = { aadl: { codeloc: string } } & Only<'aadl'>;

/**
 * SEAAL — `code_client` (2–6 alphanumeric) and `code_contrat` (2–10 digits), both
 * required. A water account commonly carries several unpaid quarterly bills; pay them as
 * one order with {@link MultiBillPayParams}.
 */
export type SeaalAccount = {
  seaal: { code_client: string; code_contrat: string };
} & Only<'seaal'>;

// ─── Statuses ─────────────────────────────────────────────────────────────────

/**
 * Transaction status.
 *
 * - `PENDING` — discovery in progress.
 * - `READY` — discovery finished; read `bills` (empty when nothing is due).
 * - `PROCESSING` — payment in progress.
 * - `UNKNOWN` — payment outcome not yet confirmed; resolves to `SUCCESS` or `REFUNDED`.
 * - `SUCCESS` — paid; `receiptUrl` and `operationId` available.
 * - `FAILED` — not paid, nothing debited.
 * - `REFUNDED` — debited then fully refunded.
 */
export type TransactionStatus =
  'PENDING' | 'READY' | 'PROCESSING' | 'UNKNOWN' | 'SUCCESS' | 'FAILED' | 'REFUNDED';

/** The statuses a payment never leaves. `UNKNOWN` is not one of them. */
export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'REFUNDED'] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Narrowing guard for {@link TerminalStatus}. */
export const isTerminal = (s: TransactionStatus): s is TerminalStatus =>
  (TERMINAL_STATUSES as readonly string[]).includes(s);

// ─── Error codes ──────────────────────────────────────────────────────────────

/** Synchronous error codes returned by the Bill Payment endpoints. */
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

/** Codes raised by the platform's key layer; they can reach any endpoint. */
export type KeyErrorCode =
  'ERR_AUTH' | 'IP_BLOCKED' | 'IP_NOT_ALLOWED' | 'API_DISABLED' | 'RATE_LIMIT_EXCEEDED';

/** `error.code` on a `FAILED` or `REFUNDED` transaction. */
export type TerminalErrorCode =
  'PAYMENT_DECLINED' | 'PARTNER_UNAVAILABLE' | 'INVALID_ACCOUNT' | 'BILL_ALREADY_PAID';

// ─── Envelope ─────────────────────────────────────────────────────────────────

/** `meta` on a success envelope. Pagination fields appear on list responses only. */
export interface ResponseMeta {
  timestamp: string;
  total?: number;
  limit?: number;
  offset?: number;
}

/** The success envelope. `GET /v3/validate` sends no `meta`, hence the optionality. */
export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
  requestId?: string;
}

/** The error envelope, including for a failed binary download. */
export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

/** A refusal that never reached the application (unknown path, proxy, gateway). */
export interface UnenvelopedError {
  message?: string;
  error?: string;
  statusCode?: number;
}

// ─── Resources ────────────────────────────────────────────────────────────────

/** Which deployment a key belongs to. A `SANDBOX` key never moves money. */
export type ApiEnvironment = 'SANDBOX' | 'PRODUCTION';

/** `GET /v3/validate`. Do not log it wholesale: `apiKey.key` is the credential. */
export interface ValidateResult {
  username: string;
  apiKey: {
    key: string;
    isEnabled: boolean;
    type: ApiEnvironment;
    /** Empty when the key is usable from anywhere. */
    allowedips: string[];
    scope: string;
  };
}

/** The environment a key belongs to. Sandbox and production share one base URL; only the key tells. */
export const environmentOf = (result: ValidateResult): ApiEnvironment => result.apiKey.type;

/** What an aggregate bill is made of. Published by AADL only; every field is optional. */
export interface BillBreakdown {
  totalRent?: number;
  totalCharges?: number;
  totalPenalties?: number;
  /** Periods folded into the aggregate. `0` means the current one only. */
  unpaidPeriods?: number;
  site?: string;
  /** Human-readable label, not an ISO date. */
  dueDate?: string;
}

/** One payable bill. The customer pays `amount + fee`. Fees are configured per partner: display, never recompute. */
export interface Bill {
  billId: string;
  amount: number;
  fee: number;
  label?: string;
  period?: string;
  breakdown?: BillBreakdown;
}

/** A transaction: one object for the discovery and the payment made from it. */
export interface Transaction {
  transactionId: string;
  /** The discovery ref. The ref passed to `pay` is not stored. */
  ref?: string;
  /** `discovery` until a payment is accepted, then `payment`. */
  type: 'discovery' | 'payment';
  status: TransactionStatus;
  partner: string;
  /**
   * The identifier, echoed flat under a partner-specific key: `reference` (ADE),
   * `contractNumber` (SONELGAZ invoice number), `codeClient` (SEAAL), `codeloc` (AADL),
   * `phoneNumber` (Algérie Télécom). Output only.
   */
  account: Record<string, string>;
  currency: string;
  createdAt: string;
  updatedAt: string;
  /** `null` while in progress; set when discovery finishes and when a payment reaches `UNKNOWN`, `SUCCESS`, `FAILED` or a completed refund. Branch on `status`, not on this. */
  completedAt: string | null;
  /** Present when `READY`. Empty when nothing is due. */
  bills?: Bill[];
  /** Present once a payment was accepted. For a multi-bill order: `amount` is the combined amount, `billId` the first id. */
  selectedBill?: Bill;
  /** Present for a multi-bill order only: each bill of the order. */
  selectedBills?: Bill[];
  /** `selectedBill.amount + selectedBill.fee`, the amount debited from your balance. */
  total?: number;
  /** Present when `SUCCESS`. */
  receiptUrl?: string;
  /** Present when `SUCCESS`. */
  operationId?: string;
  /** Present when `FAILED` or `REFUNDED`. */
  error?: { code: TerminalErrorCode; message: string };
}

/** `POST /v3/bills/discover` acknowledgement. Poll for the outcome. */
export interface DiscoverAck {
  transactionId: string;
  ref: string;
  status: 'PENDING';
}

/** `POST /v3/bills/pay` acknowledgement. `ref` is the discovery ref. Poll for the outcome. */
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
  /** Required, max 100 characters, unique per partner. Reuse answers `403 DUPLICATED_REF`. */
  ref: string;
}

/** `POST /v3/bills/pay`. Exactly one of `billId` or `billIds`. */
export type PayParams = SingleBillPayParams | MultiBillPayParams;

type PayCommon = {
  /** A `READY` discovery, 24 hexadecimal characters. */
  transactionId: string;
  /**
   * A new ref for this payment, max 100 characters. It must differ from the discovery ref
   * and from any ref still in use for the partner (`403 DUPLICATED_REF`). Use
   * {@link payRefFor}. The transaction keeps the discovery ref; this one is not stored.
   */
  ref: string;
};

/** Pay one bill from the transaction's `bills`. */
export type SingleBillPayParams = PayCommon & { billId: string; billIds?: never };

/**
 * Pay 1 to 50 distinct bills from the transaction's `bills` as one order, with one fee on
 * the combined amount. Every id must belong to the transaction or nothing is paid.
 */
export type MultiBillPayParams = PayCommon & { billIds: string[]; billId?: never };

/** `GET /v3/bills/transactions`. */
export interface ListParams {
  status?: TransactionStatus;
  partner?: Partner;
  /** ISO 8601 lower bound on `createdAt`. */
  from?: string;
  /** ISO 8601 upper bound on `createdAt`. */
  to?: string;
  /** 1–100, default 20. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

/** `GET /v3/bills/transactions/by-ref`. */
export interface GetByRefParams {
  /** The discovery ref. */
  ref: string;
  /** Narrows the lookup to one partner. */
  partner?: Partner;
}

/** A page of transactions. Counts come from `meta`, falling back to the page itself. */
export interface TransactionList {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

/** A downloaded file with the headers needed to save or serve it. */
export interface Receipt {
  /** The file. Typed `Uint8Array<ArrayBuffer>` so it is a valid `BlobPart` (TypeScript ≥ 5.7). */
  bytes: Uint8Array<ArrayBuffer>;
  /** `application/pdf`, `image/png`, `image/jpeg` or `application/octet-stream`. */
  contentType: string;
  /** From `Content-Disposition`, or a fallback built from the transaction id and `contentType` (browsers cannot read the header). */
  filename: string;
  /** Correlation id, or `null` (browsers cannot read the header). */
  requestId: string | null;
}

/** AADL's avis de paiement. Same shape as {@link Receipt}. */
export type Avis = Receipt;

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
  /** Defaults to `https://api.oneclickdz.com`, which serves both environments. Blank counts as absent. */
  baseUrl?: string;
  /** Per-request timeout. Defaults to 15000. */
  timeoutMs?: number;
  /** Extra attempts for GET only. Defaults to 2. POSTs are never retried. */
  retries?: number;
  /** Inject a `fetch` for testing. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /** Called before each attempt. */
  onRequest?: (ctx: HookContext) => void;
  /** Called after each attempt, including failed ones. */
  onResponse?: (ctx: HookContext) => void;
}

/** Options for the polling helpers. */
export interface PollOptions {
  /** Whole-wait budget, reads included. Defaults to 120000. */
  timeoutMs?: number;
  /** First delay between polls. Backs off to `maxIntervalMs`. Defaults to 1000. */
  intervalMs?: number;
  /** Backoff ceiling. Defaults to 5000. */
  maxIntervalMs?: number;
  /** Cancel the wait. Rejects with {@link BillPayAbortError}. */
  signal?: AbortSignal;
  /** Called with every transaction the poll reads, including the last. Exceptions are swallowed. */
  onPoll?: (transaction: Transaction) => void;
}
