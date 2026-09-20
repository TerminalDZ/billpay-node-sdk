/**
 * Wire types for the OneClickDz Bill Payment API (`/v3`).
 *
 * Written by hand against what the live API actually returns, not generated from
 * `openapi.yaml`. The published spec and the guides disagree with the deployment in
 * several places; where they do, the observed behaviour wins and these types follow it.
 * Every shape here was checked against a real sandbox response before it was written
 * down, and the comments record the checks that a type cannot express.
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

/** Availability of a single partner, as the live map reports it. */
export type PartnerStatus = 'ACTIVE' | 'UNAVAILABLE';

/**
 * The `GET /v3/bills/partners` payload: one entry per partner.
 *
 * Keyed by the partner's literal name, so the keys are the {@link Partner} values —
 * typed as `string` because the API is free to add a biller without an SDK release, and
 * a narrower key type would make a new one unreadable rather than merely unknown.
 *
 * This map is the *only* honest source of availability. It changes without warning, in
 * both environments, so read it at runtime and drive your UI from it; never hard-code a
 * partner as on or off, and do not trust a statement about availability written in any
 * document, including this one.
 */
export type PartnersMap = Record<string, { status: PartnerStatus }>;

// ─── Account identifiers ──────────────────────────────────────────────────────

/**
 * An account identifier carries **exactly one** field. Zero, or more than one, is
 * rejected — `ERR_VALIDATION` from the Joi layer or `INVALID_ACCOUNT` from the
 * controller, depending on which notices first.
 *
 * The union below makes a wrong combination a compile-time error. Each member is
 * "one field, plus every other field explicitly `never`", which is what stops
 * TypeScript from silently accepting an object with two identifiers. The server says the
 * same thing at runtime: "Exactly one of electronic_payment_key, phone_number, sonelgaz,
 * ade, aadl, or seaal is required".
 *
 * Responses echo a **flat** identifier, keyed by partner:
 * `reference` (ADE) · `contractNumber` (SONELGAZ) · `codeloc` (AADL) ·
 * `phoneNumber` (Algérie Télécom) · `codeClient` (SEAAL). The nested request forms
 * (`ade{}`, `aadl{}`, `seaal{}`) are flattened on the way out — `ade{}` echoes as
 * `reference`, `aadl{}` as `codeloc`, and `seaal{}` as `codeClient` alone.
 */
export type AccountIdentifier =
  | ReferenceAccount
  | ContractNumberAccount
  | PhoneNumberAccount
  | ElectronicPaymentKeyAccount
  | PhoneNumberSnakeAccount
  | SonelgazInvoiceAccount
  | AdeInvoiceAccount
  | AadlAccount
  | SeaalAccount;

/** Only the listed key may be present; the rest are pinned to `never`. */
type Only<K extends string> = { [P in Exclude<AccountKey, K>]?: never };

type AccountKey =
  | 'reference'
  | 'contractNumber'
  | 'phoneNumber'
  | 'electronic_payment_key'
  | 'phone_number'
  | 'sonelgaz'
  | 'ade'
  | 'aadl'
  | 'seaal';

/**
 * ADE. Max 50 characters.
 *
 * ADE only. SEAAL used to be documented as sharing this slot; it does not — it takes the
 * nested pair {@link SeaalAccount} and has no flat identifier at all.
 */
export type ReferenceAccount = { reference: string } & Only<'reference'>;

/** SONELGAZ. Max 50 characters. */
export type ContractNumberAccount = { contractNumber: string } & Only<'contractNumber'>;

/**
 * Algérie Télécom. An Algerian **landline**, in local form: `^0[2-4][0-9]{7}$`.
 *
 * The international `+213…` spelling of the same number is refused — `400 ERR_VALIDATION`,
 * "phoneNumber must be a valid Algerian landline number" — so a front end that normalises
 * phone input to E.164 has to stop short of this field. Send what the customer would dial
 * at home: `'023456789'`, not `'+21323456789'`. A mobile number is rejected too; the
 * second digit is what separates the two.
 */
export type PhoneNumberAccount = { phoneNumber: string } & Only<'phoneNumber'>;

/**
 * Internal snake_case form. Exactly 25 characters — not "up to", exactly.
 *
 * It is not the SEAAL identifier either, whatever a 25-character key was once said to
 * cover: SEAAL authenticates on a pair, {@link SeaalAccount}.
 */
export type ElectronicPaymentKeyAccount = {
  electronic_payment_key: string;
} & Only<'electronic_payment_key'>;

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

/**
 * AADL. One field, `codeloc`, and nothing else.
 *
 * `codeloc` is the housing file number: digits only, 6 to 20 of them, always required.
 * It must travel **inside** the `aadl` object — a flat `account.codeloc`, like the
 * retired `aadlNumber` shorthand, is `400 ERR_VALIDATION` with "account must contain
 * exactly one identifier".
 *
 * There is no second AADL method. The `billnum`/`amount` pair this type used to accept
 * was removed from the contract: the server's Joi layer strips unknown keys rather than
 * rejecting them, so sending them still answers `200` — but it changes nothing, and
 * leniency is not a contract. Modelling `codeloc` alone is what keeps a caller from
 * building on behaviour that was never promised.
 *
 * **An AADL housing file bills one aggregate total, never a list.** There is exactly one
 * open avis per file at a time, with every unpaid earlier period folded into it — the
 * bill says how many in `breakdown.unpaidPeriods` — and AADL publishes no per-period
 * invoice behind that total. So a discovery returns one payable entry however far behind
 * the tenant is, none of it is separately payable, and the multi-bill picker you built
 * for SEAAL is the wrong screen here: it will render a list of one, forever. Show the
 * total, and pay it whole.
 */
export type AadlAccount = { aadl: { codeloc: string } } & Only<'aadl'>;

/**
 * SEAAL nested pair form. Both fields required — the portal authenticates on the PAIR.
 *
 * `code_client` is 2 to 6 alphanumeric characters, `^[A-Za-z0-9]{2,6}$`; `code_contrat`
 * is 2 to 10 digits, `^\d{2,10}$`. Both are printed on the customer's paper water bill,
 * and neither is optional: send one without the other and the validator answers
 * "seaal.code_client must be 2 to 6 alphanumeric characters" or "seaal.code_contrat
 * must be 2 to 10 digits".
 *
 * There is **no flat shorthand**. SEAAL has no single key that identifies an account, so
 * neither `reference` nor `electronic_payment_key` stands in for the pair however
 * convenient that would be. Responses do flatten it, to `codeClient` alone — that is an
 * echo, not a form you can send back.
 *
 * **A water account commonly owes many bills at once.** Factures are quarterly and a real
 * account has been seen carrying 45 of them, so SEAAL is the partner a multi-bill picker
 * is actually for — the opposite of {@link AadlAccount}'s single aggregate. Settle the
 * whole selection in one call: {@link MultiBillPayParams} sends `billIds`, the portal
 * receives one transaction, and the fee is charged once on the total.
 *
 * Paying them one at a time costs twice over, which is worth knowing before you build the
 * picker. SEAAL's fee is floored at 30 DZD and a facture is a few hundred dinars, so every
 * separate payment is charged that floor — five quarters settled one by one cost 150.00 in
 * fees against 30.00 for the same five as one order. And the account-level double-pay
 * guard is keyed on `code_client` and windowed at 24 hours, so a *second* discovery for
 * the same water account inside that window — after one quarter has settled — answers
 * `409 BILL_ALREADY_PAID` rather than listing the rest. One order is not a convenience
 * here; it is how an arrears list gets cleared in one sitting.
 */
export type SeaalAccount = {
  seaal: { code_client: string; code_contrat: string };
} & Only<'seaal'>;

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
  'PENDING' | 'READY' | 'PROCESSING' | 'UNKNOWN' | 'SUCCESS' | 'FAILED' | 'REFUNDED';

/** The three statuses a transaction never leaves. `UNKNOWN` is deliberately absent. */
export const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'REFUNDED'] as const;

/** A status a transaction never leaves. */
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Narrowing guard for {@link TerminalStatus}. `UNKNOWN` returns `false`. */
export const isTerminal = (s: TransactionStatus): s is TerminalStatus =>
  (TERMINAL_STATUSES as readonly string[]).includes(s);

// ─── Error codes ──────────────────────────────────────────────────────────────

/** Every synchronous error code the Bill Payment endpoints return. There are thirteen. */
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
 * Codes raised by the shared key layer rather than by Bill Payment itself.
 *
 * They can reach any endpoint on the platform, so the SDK maps them even though none is
 * part of the Bill Payment contract proper. `ERR_AUTH` is an older alias the gateway
 * still emits alongside `INVALID_ACCESS_TOKEN`.
 *
 * `IP_BLOCKED` is the other end of the twenty-attempt lockout: once the counter runs out
 * the gateway stops answering this address for about fifteen minutes. It is a statement
 * about your key and where you are calling from, not about the request, which is why it
 * belongs beside `IP_NOT_ALLOWED` rather than among the conflicts its `403` would
 * otherwise sort it into.
 */
export type KeyErrorCode =
  'ERR_AUTH' | 'IP_BLOCKED' | 'IP_NOT_ALLOWED' | 'API_DISABLED' | 'RATE_LIMIT_EXCEEDED';

/**
 * The four reasons that appear inside a transaction's `error`, and only when the
 * status is `FAILED` or `REFUNDED`.
 *
 * `NO_BILLS_FOUND` appears in `openapi.yaml` but is never emitted — a discovery that
 * finds nothing is reported as `READY` with `bills: []`, not as an error.
 */
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

/**
 * The success envelope. Every endpoint except the two binary downloads returns this.
 *
 * `meta` and `requestId` are optional because the server does not always send them:
 * `GET /v3/validate` answers with `success` and `data` alone. Code that reaches into
 * `meta` unconditionally throws a `TypeError` on exactly that response, which is why
 * the optionality is modelled rather than assumed away.
 */
export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: ResponseMeta;
  requestId?: string;
}

/**
 * The error envelope, used by every endpoint that reaches the application — including
 * the binary downloads when they fail.
 *
 * A request that never reaches the application does **not** use it: a path the router
 * does not know answers `{ message, error, statusCode }` with no `success` field at all.
 * The transport recognises that shape separately and turns it into the same typed error
 * this one produces, so a caller never has to care which layer refused them.
 */
export interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string; details?: unknown };
  requestId?: string;
}

/**
 * A router-level refusal: Fastify's own 404 body, and the shape any proxy in front of
 * the API is likely to emit. No `success`, no `error.code` — just a status and a
 * sentence. {@link ErrorEnvelope} is the shape you normally get.
 */
export interface UnenvelopedError {
  message?: string;
  error?: string;
  statusCode?: number;
}

// ─── Resources ────────────────────────────────────────────────────────────────

/** Which deployment a key belongs to. A `SANDBOX` key never moves money. */
export type ApiEnvironment = 'SANDBOX' | 'PRODUCTION';

/**
 * `GET /v3/validate` — who the key belongs to and what it may do.
 *
 * `username` is the account's login identifier, in practice the phone number the account
 * was registered with. Everything else describes the key itself.
 */
export interface ValidateResult {
  username: string;
  apiKey: {
    /** Echoed back verbatim. Do not log this object wholesale because of this field. */
    key: string;
    isEnabled: boolean;
    /** Sandbox or production. See {@link environmentOf}. */
    type: ApiEnvironment;
    /** Empty when the key is usable from anywhere; otherwise the whitelist. */
    allowedips: string[];
    /** What the key is permitted to do, e.g. `'READ-WRITE'`. */
    scope: string;
  };
}

/**
 * The environment a key belongs to, from a {@link ValidateResult}.
 *
 * The environment lives at `apiKey.type` — one level deeper than it reads, and easy to
 * reach for on the wrong object, since the response also has a `key` *string* next to
 * it. This spares you remembering which is which:
 *
 * ```ts
 * if (environmentOf(await client.validate()) === 'PRODUCTION') confirmWithTheOperator();
 * ```
 *
 * It is the only trustworthy answer to "am I about to move real money?". Sandbox and
 * production share one base URL, so the URL tells you nothing and only the key does.
 */
export const environmentOf = (result: ValidateResult): ApiEnvironment => result.apiKey.type;

/**
 * The partner's own explanation of what makes up a bill's `amount`. Present only when
 * the partner publishes one — today that is AADL, where the total is an aggregate of
 * rent, charges and late penalties across `unpaidPeriods` periods, which is why a
 * tenant cannot pay a subset of it.
 *
 * Every field is optional and emitted only when the partner supplies it. Treat a
 * missing `breakdown` as "no breakdown published", never as zeroes — a `0` you invented
 * is indistinguishable from a `0` the biller published, and the customer reads both.
 */
export interface BillBreakdown {
  /** Rent component. */
  totalRent?: number;
  /** Charges component. */
  totalCharges?: number;
  /** Late penalties. */
  totalPenalties?: number;
  /** How many periods are folded into the aggregate. `0` means the current one only. */
  unpaidPeriods?: number;
  /** Residence / programme label. */
  site?: string;
  /** Human due-date label, not an ISO timestamp. */
  dueDate?: string;
}

/**
 * One payable bill. `fee` is already included in `Transaction.total` when selected.
 *
 * `fee` is what this bill costs to settle **on its own**, and it does not add up across a
 * selection: several bills paid together are one order carrying one fee on the combined
 * total, which is less than these figures summed wherever a floor is in play. See
 * {@link MultiBillPayParams}.
 *
 * Sandbox returns `fee: 0`, so `total === amount` there and an integration that quietly
 * charges `amount` looks correct right up until production. Read both.
 */
export interface Bill {
  billId: string;
  amount: number;
  fee: number;
  label?: string;
  period?: string;
  /** Partner-supplied component breakdown of `amount`. Absent for most partners. */
  breakdown?: BillBreakdown;
}

/**
 * A transaction, as returned by `get`, `getByRef` and `list`.
 *
 * Beware: `list` does not populate `bills` or `error` — see {@link BillsResource.list}.
 * Read a specific transaction with `get` before acting on either field.
 */
export interface Transaction {
  transactionId: string;
  /** Always the **discovery** ref, never a ref passed to `pay`. */
  ref?: string;
  type: 'discovery' | 'payment';
  status: TransactionStatus;
  partner: string;
  /**
   * The identifier echoed **flat**, one key: `reference` (ADE) · `contractNumber`
   * (SONELGAZ) · `codeloc` (AADL) · `phoneNumber` (Algérie Télécom) · `codeClient`
   * (SEAAL). The SEAAL echo is the `code_client` half alone — the pair does not survive
   * the round trip, so keep your own copy of `code_contrat`.
   */
  account: Record<string, string>;
  currency: string;
  createdAt: string;
  updatedAt: string;
  /**
   * When the transaction last stopped working — **not** a terminality flag.
   *
   * The server sets it whenever the current phase ends, which includes states that are
   * still in play: a freshly `READY` discovery carries one although nothing has been
   * paid, and so does an `UNKNOWN` payment sitting in review. It is rewritten when that
   * review resolves, so it is not even a stable record of the first completion. Only
   * `PENDING` and `PROCESSING` are reliably `null`.
   *
   * Branch on `status` — {@link isTerminal} is there for exactly this — and treat this
   * field as a timestamp to display, never as a condition to test.
   */
  completedAt: string | null;
  /** Present when `status === 'READY'`. Empty array means nothing payable. */
  bills?: Bill[];
  /**
   * What the transaction settled, as **one line** however many bills went into it.
   *
   * After a `billIds` payment this is the aggregate of the selection rather than one of
   * the factures in it: `amount` is the sum of the chosen bills, `fee` is the single fee
   * computed on that sum, and `billId` is the **first** id you sent — not a bill you can
   * reconcile against on its own. {@link Bill} carries no count, so keep your own list of
   * what you selected. See {@link MultiBillPayParams}.
   */
  selectedBill?: Bill;
  /**
   * `selectedBill.amount + selectedBill.fee`, present once a bill is selected — so for a
   * multi-bill order it is the whole order: every chosen bill, plus one fee.
   */
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
 * `ref` echoes the **discovery** ref, which is the ref the transaction keeps and the
 * only one `getByRef` resolves.
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
  /**
   * Required. Max 100 characters. Unique **per partner** among transactions that are
   * still live — a second discovery reusing one answers `403 DUPLICATED_REF`, whichever
   * account it names.
   *
   * The account is not part of the key, so a ref derived from a batch rather than from a
   * customer collides on the second customer of the run. Derive it from whatever is
   * unique on your side — the order, the invoice — or let {@link newRef} do it.
   */
  ref: string;
}

/**
 * `POST /v3/bills/pay`.
 *
 * A payment names **exactly one** selection: a single `billId`, or a `billIds` array.
 * Both, or neither, is rejected — `400 ERR_VALIDATION`, "Provide exactly one of billId
 * or billIds". So the two forms are a union rather than two optional fields, in the same
 * spirit as {@link AccountIdentifier}: each member pins the other key to `never`, which
 * makes the wrong combination a compile error instead of a refusal you meet in front of
 * a customer.
 */
export type PayParams = SingleBillPayParams | MultiBillPayParams;

/** What both forms carry. The bills are the only thing that differs. */
type PayCommon = {
  /** 24-character lowercase hex. Anything else is rejected by `paySchema`. */
  transactionId: string;
  /**
   * Required, max 100 characters. Use a value of your own per payment —
   * {@link payRefFor} derives one from the discovery ref.
   *
   * The docs call a distinct pay ref mandatory and say reusing the discovery ref
   * answers `403 DUPLICATED_REF`; live testing shows the deployment accepts it and
   * answers `200 PROCESSING`. Treat a fresh ref as the convention it is — it keeps your
   * own logs unambiguous and survives the day the server starts enforcing the rule —
   * rather than as a constraint you must engineer around.
   *
   * Whatever you send is validated and then discarded: the transaction keeps its
   * discovery ref, so a later `getByRef` with this value returns 404. Use
   * {@link BillsResource.getByRef} with the *discovery* ref to recover.
   */
  ref: string;
};

/**
 * Pay one discovered bill, named by its `billId`. Max 100 characters.
 *
 * Unchanged, and still the right form nearly everywhere: every partner but SEAAL returns
 * a single bill from a discovery anyway. `billIds: [id]` is equivalent — one bill is one
 * order either way — so there is nothing here to migrate.
 */
export type SingleBillPayParams = PayCommon & { billId: string; billIds?: never };

/**
 * Pay several discovered bills as **one order**. 1 to 50 ids, each max 100 characters,
 * and no id twice: a repeat is `400 ERR_VALIDATION`, "billIds must not repeat the same
 * bill id".
 *
 * **One fee, computed on the combined total.** This is the surprising part, and the
 * reason the form exists. The selection becomes one portal order and one card payment,
 * so it is charged a single service fee on the sum — never the sum of the `fee` each
 * {@link Bill} carries. SEAAL's rule is 0.5 %, floored at 30 DZD and capped at 60 DZD,
 * and a water facture is a few hundred dinars, so the percentage never clears the floor
 * and a facture settled alone costs exactly 30.00 in fees. Three of them — 327.00,
 * 512.66 and 735.15 — total 1574.81, whose 0.5 % is 7.87, still under the floor: the
 * order is charged 30.00 once and debits 1604.81. Paid one by one the same three cost
 * 90.00 in fees. Quote the total, then one fee on it; adding the per-bill figures up
 * overcharges the customer.
 *
 * **All or nothing.** Every id must belong to the transaction. The selection is applied
 * in a single atomic transition that requires *all* of them, so one stale or forged id
 * fails the whole payment rather than quietly settling the subset that was still good.
 * The already-paid and payment-in-progress guards run for every id too, and each looks at
 * both the aggregate and the itemised lines of earlier payments — a facture settled
 * before as one line of a group is still recognised as paid.
 *
 * **The transaction reports the aggregate**, not the lines: see
 * {@link Transaction.selectedBill}, whose `billId` is the first id of your selection.
 *
 * **Only some billers can do this.** It is meaningful where the biller's own portal
 * accepts several documents in one transaction, which today is SEAAL — quarterly water,
 * where an account routinely owes many unpaid quarters and 25 on a verified production
 * account is ordinary. Everyone else returns a single bill from discovery, so `billIds`
 * with one entry there is {@link SingleBillPayParams} spelled longer.
 *
 * Sandbox does the same arithmetic as production — the same aggregate, the same one fee
 * on the total — so the shape you validate there is the shape you will be charged. Its
 * `fee` is still `0`, as it is for every partner in sandbox.
 */
export type MultiBillPayParams = PayCommon & { billIds: string[]; billId?: never };

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
  /** The **discovery** ref. A pay ref never resolves. */
  ref: string;
  /** Narrows the lookup. Without it the ref must be unique across your partners. */
  partner?: Partner;
}

/**
 * A paginated list result.
 *
 * The counts come from the envelope's `meta`, not from the body, and the server does
 * not always send them — when it does not, they are derived from the page you were
 * given, so `total` is a floor rather than a promise.
 */
export interface TransactionList {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * A downloaded file: the bytes, and enough of the response headers to save or serve
 * them without going back to the transport.
 */
export interface Receipt {
  /**
   * The file itself.
   *
   * Pinned to `Uint8Array<ArrayBuffer>` rather than left bare because since TypeScript
   * 5.7 a bare `Uint8Array` means `Uint8Array<ArrayBufferLike>`, which includes
   * `SharedArrayBuffer` and so is not assignable to `BlobPart`. That would make
   * `new Blob([receipt.bytes])` — the only way to show or save this in a browser — a
   * compile error in the consumer's own source, where `skipLibCheck` cannot hide it.
   * The bytes really do come from an `ArrayBuffer`, so the narrower type is also the
   * accurate one. It does mean a consumer needs TypeScript 5.7 or newer.
   */
  bytes: Uint8Array<ArrayBuffer>;
  /** `application/pdf`, `image/png`, `image/jpeg` or `application/octet-stream`. */
  contentType: string;
  /**
   * Parsed from `Content-Disposition`, with a fallback built from the transaction id and
   * an extension inferred from `contentType`.
   *
   * The fallback is the normal case in a browser, not the exotic one:
   * `Content-Disposition` is not on the CORS safelist and the API sends no
   * `Access-Control-Expose-Headers`, so `Headers.get` returns `null` for it however
   * plainly the header sits on the wire. Under Node you get the server's name; in a
   * browser you get ours. Both end in a usable extension, which is what a `saveAs` needs.
   */
  filename: string;
  /**
   * Correlation id for this download, or `null`.
   *
   * `null` in a browser for the same CORS reason as `filename` — `x-request-id` is not
   * safelisted either. Errors are unaffected: those carry the id in the body, and the
   * transport prefers that copy.
   */
  requestId: string | null;
}

/**
 * AADL's *avis de paiement*, downloaded by {@link BillsResource.avis}.
 *
 * Deliberately the same shape as {@link Receipt} — both are "bytes plus the headers you
 * need to file them" — so one helper in your code can save either. The two documents
 * are not interchangeable, though: the receipt proves your payment went through, the
 * avis is AADL's own statement of what the housing file owes. Store the receipt against
 * your order; hand the avis to the tenant.
 */
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
  /**
   * Defaults to `https://api.oneclickdz.com`, which serves both environments. Blank or
   * whitespace counts as absent, so an unset `BILLPAY_BASE_URL=` passed straight through
   * gets the default rather than an invalid URL. An unparseable value is rejected when
   * the client is constructed.
   */
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
  /**
   * Give up after this long, and mean it: the budget covers the reads as well as the
   * waits between them, so a hanging request or a long `Retry-After` cannot push the
   * give-up past it. Defaults to 120000.
   */
  timeoutMs?: number;
  /** First delay between polls. Backs off to `maxIntervalMs`. Defaults to 1000. */
  intervalMs?: number;
  /** Backoff ceiling. Defaults to 5000. */
  maxIntervalMs?: number;
  /** Cancel the wait. Rejects with {@link BillPayAbortError}. */
  signal?: AbortSignal;
  /**
   * Called with every transaction the poll reads, including the one it finally returns.
   *
   * The promise these helpers return can only ever tell you where a transaction ended
   * up. That is the wrong shape for anything with a screen attached: a payment that
   * held on `UNKNOWN` for a minute and then refunded is, after the fact, indis-
   * tinguishable from one that refunded immediately — and those two want very different
   * things said to the customer.
   *
   * This hook is how a UI follows the transaction without reimplementing the backoff,
   * the deadline and the cancellation, which is to say without testing a copy of them.
   *
   * It is called on the caller's behalf inside the poll loop, so keep it cheap and do
   * not throw from it — an exception here would abandon a wait that may have money
   * behind it. Anything thrown is swallowed for that reason.
   */
  onPoll?: (transaction: Transaction) => void;
}
