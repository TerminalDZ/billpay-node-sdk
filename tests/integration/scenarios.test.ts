/**
 * Integration suite — the live sandbox at `https://api.oneclickdz.com`.
 *
 * Every assertion here was written against a response the real deployment actually
 * sent, and the suite is the only thing in this repo that can tell you the SDK still
 * matches the API. Unit tests prove the SDK is self-consistent; these prove it is right.
 *
 * The sandbox picks its outcome from the account identifier, so the matrix below *is*
 * the fixture set: no seeding, no teardown, and a decline or a refund on demand. The
 * only per-run state is the `ref`, which must be fresh — see {@link mintRef}. Setup,
 * the sandbox-key check and the reachability skip all live in `./live.js`.
 *
 * Two things are deliberately never asserted. A partner being `ACTIVE` is an operator
 * setting rather than a contract, so a scenario whose biller is switched off skips with
 * a printed reason instead of failing. And the invalid-key path spends one of twenty
 * attempts before a lockout, so it is opt-in.
 */

import { describe, expect, it } from 'vitest';
import {
  BillPayAuthError,
  BillPayConflictError,
  BillPayError,
  BillPayNotFoundError,
  BillPayUnavailableError,
  BillPayValidationError,
  environmentOf,
  isTerminal,
  PARTNERS,
  payRefFor,
  type Avis,
  type PayAck,
  type Transaction,
  type TransactionStatus,
} from '../../src/index.js';
import {
  available,
  BASE_URL,
  client,
  discoverReady,
  exerciseBadKey,
  live,
  mintRef,
  SANDBOX_KEY,
  sleep,
  withRateLimitRetry,
  type Discovery,
} from './live.js';

// ─── Budgets ──────────────────────────────────────────────────────────────────

/** A discovery or a lookup. Generous: this is a real network, not a local stack. */
const NET = 60_000;
/** Discover, pay, settle and download. */
const ROUND_TRIP = 120_000;
/** The review scenario holds `UNKNOWN` for about a minute on purpose. */
const REVIEW = 240_000;

// ─── The scenario matrix, as identifiers ──────────────────────────────────────

/**
 * AADL housing files. The identifier is `{ aadl: { codeloc } }` and nothing else —
 * `codeloc` is the whole contract, and a flat `account.codeloc` is `ERR_VALIDATION`.
 */
const AADL = {
  /** READY, one avis @ 5400.00, `Août 2026`, breakdown with nothing overdue. */
  payable: '1112223334',
  /** READY, one aggregate avis @ 12000.00, `Juillet 2026`, two periods folded in. */
  arrears: '2223334445',
  /** READY with an empty `bills[]` — no open avis. */
  nothingDue: '3334445556',
  /** Refused at discovery: `409 BILL_ALREADY_PAID`. */
  settled: '4445556667',
} as const;

/** ADE references. Twenty-five characters, and the digits choose the ending. */
const ADE = {
  /** READY, one bill @ 443.39, pays to SUCCESS. The documented end-to-end run. */
  happy: '0123456789012345678901234',
  /** READY, `bills: []`. */
  nothingDue: '0123456789012340000000002',
  /** READY, `bills: []` — one 150.00 bill, filtered by the 200 DZD floor. */
  underFloor: '0123456789012341111111111',
  /** READY, one bill @ 400.00, pays to FAILED + PAYMENT_DECLINED. */
  declined: '0123456789012340000000004',
  /** READY, one bill @ 550.00, debited then reversed: REFUNDED. */
  refunded: '0123456789012340000000005',
  /** `400 INVALID_ACCOUNT` — the customer mistyped. */
  malformed: 'abc0000000000000000000000',
  /** `503 PARTNER_UNAVAILABLE` — the biller's portal did not answer. */
  unreachable: '0123456789012345005005005',
  /** `409 BILL_ALREADY_PAID` — the 24-hour guard. */
  alreadyPaid: '0123456789012347777777777',
} as const;

/** The nested ADE invoice form: a different identifier slot, debited then refunded. */
const ADE_INVOICE = {
  sub_id: '000123456789',
  period: '07/2026',
  amount: '12000',
  pay_key: '1234567',
} as const;

/** SONELGAZ invoices. All three fields are required whatever the scenario. */
const SONELGAZ = {
  /** READY, two bills @ 1200.00 and 850.00 — the multi-bill picker. */
  multi: { invoice_number: '9876543210', amount_without_stamp: '15000', ebb_key: 'ABC123' },
  /** READY, `bills: []` — everything owed is under the floor. */
  underFloor: { invoice_number: '0000000003', amount_without_stamp: '15000', ebb_key: 'ABC123' },
  /** READY, one bill @ 900.00, then `UNKNOWN` for about a minute before REFUNDED. */
  review: { invoice_number: '6006006006', amount_without_stamp: '15000', ebb_key: 'ABC123' },
} as const;

/** An Algerian landline: `0`, a digit 2–4, then seven more. READY, one bill @ 300.00. */
const LANDLINE = '023456789';

/**
 * SEAAL water accounts. The identifier is a **pair** and both halves are mandatory:
 * `code_client` is 2–6 alphanumeric characters, `code_contrat` is 2–10 digits. There is
 * no flat shorthand — `reference` is ADE's and has never reached SEAAL, whatever earlier
 * versions of this file asserted while the biller was switched off.
 *
 * The sandbox branches on `code_client` alone; `code_contrat` is an authentication
 * factor, not a selector, so the same one is used throughout.
 */
const SEAAL = {
  /** READY, five unpaid quarterly factures — the signature multi-bill shape. */
  quarters: { code_client: '100001', code_contrat: '446547' },
  /** READY, `bills: []` — the account is fully settled. */
  settled: { code_client: '100003', code_contrat: '446547' },
} as const;

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Await a call that must reject and hand back what it threw, typed for assertion. */
const rejection = async <T extends BillPayError>(p: Promise<unknown>): Promise<T> =>
  (await p.catch((e: unknown) => e)) as T;

/**
 * Pay the first discovered bill and wait for the transaction to settle.
 *
 * The pay ref is derived rather than reused. The live deployment accepts the discovery
 * ref here — the published `403` never materialised — but a distinct ref is the
 * convention the docs ask for and the one that survives the server enforcing it.
 */
const payFirstBill = async (
  d: Discovery,
  timeoutMs = 90_000,
): Promise<{ ack: PayAck; settled: Transaction; payRef: string }> => {
  const c = client();
  const bill = d.txn.bills![0]!;
  const payRef = payRefFor(d.ref);
  const ack = await withRateLimitRetry(() =>
    c.bills.pay({ transactionId: d.txn.transactionId, billId: bill.billId, ref: payRef }),
  );
  const settled = await c.bills.waitForTerminal(d.txn.transactionId, { timeoutMs });
  return { ack, settled, payRef };
};

// Resolved before collection by `./live.js`, so `skipIf` sees plain booleans and the
// reporter shows a skipped scenario rather than a silently passing one.
const liveAadl = live && available('AADL');
const liveAde = live && available('ADE');
const liveSonelgaz = live && available('SONELGAZ');
const liveTelecom = live && available('Algérie Télécom');
const liveSeaal = live && available('SEAAL');

// ─── Identity ─────────────────────────────────────────────────────────────────

describe.skipIf(!live)('identity and partner availability', () => {
  it(
    'validate reports a SANDBOX key and who it belongs to',
    async () => {
      const r = await client().validate();

      // The environment is at `apiKey.type`, next to an `apiKey.key` that is the
      // credential itself. Reading the wrong one is how a suite ends up pointed at
      // production and cheerfully reporting green.
      expect(r.apiKey.type).toBe('SANDBOX');
      expect(environmentOf(r)).toBe('SANDBOX');
      expect(r.apiKey.key).toBe(SANDBOX_KEY);
      expect(r.apiKey.isEnabled).toBe(true);
      expect(r.apiKey.scope).toBeTruthy();
      expect(Array.isArray(r.apiKey.allowedips)).toBe(true);
      expect(r.username).toBeTruthy();

      // This response carries no `meta`. That it decodes at all is the regression test:
      // an envelope type with a required `meta` throws a TypeError right here.
    },
    NET,
  );

  it(
    'environment() answers the same question in one field',
    async () => {
      expect(await client().environment()).toBe('SANDBOX');
    },
    NET,
  );

  it(
    'the partner map carries every partner the SDK knows, accents intact',
    async () => {
      const map = await client().partners();

      for (const partner of PARTNERS) {
        expect(map[partner], `the live map is missing ${partner}`).toBeDefined();
        expect(['ACTIVE', 'UNAVAILABLE']).toContain(map[partner]!.status);
      }

      // `Algérie Télécom` is compared character for character by the API — the
      // unaccented spelling is a different, unknown partner.
      expect(map['Algérie Télécom']).toBeDefined();
      expect(map['Algerie Telecom']).toBeUndefined();

      // Drift detector, not an availability assertion: a sixth biller means the
      // `Partner` union is stale, and a caller typing against it cannot reach the
      // new one.
      expect(Object.keys(map)).toHaveLength(PARTNERS.length);
    },
    NET,
  );

  it(
    'a request with no token is refused with MISSING_ACCESS_TOKEN and a requestId',
    async () => {
      // Sent by hand: the client refuses to be built without a key, which is the point.
      // No key is sent, so this costs nothing against the lockout counter.
      const res = await fetch(`${BASE_URL}/v3/validate`);
      const body = (await res.json()) as { success: false; error: { code: string } };

      expect(res.status).toBe(401);
      expect(body.error.code).toBe('MISSING_ACCESS_TOKEN');
      expect(res.headers.get('x-request-id')).toBeTruthy();
    },
    NET,
  );
});

describe.skipIf(!live || !exerciseBadKey)('identity — the invalid-key path (opt-in)', () => {
  it(
    'an unknown key is refused once, and never retried into a lockout',
    async () => {
      // Exactly one attempt: `retries: 0`, one call, no loop over candidates. Twenty
      // consecutive failures lock the key out, and the message counts them down for you.
      const e = await rejection<BillPayAuthError>(
        client({ apiKey: `it-${Date.now()}-not-a-key`, retries: 0 }).validate(),
      );

      expect(e).toBeInstanceOf(BillPayAuthError);
      expect(e.httpStatus).toBe(401);
      expect(e.code).toBe('INVALID_ACCESS_TOKEN');
    },
    NET,
  );
});

// ─── AADL ─────────────────────────────────────────────────────────────────────

describe.skipIf(!liveAadl)('AADL — one aggregate avis, addressed by codeloc', () => {
  it(
    'the payable file returns one avis with its breakdown, and echoes codeloc flat',
    async () => {
      const { ack, txn } = await discoverReady(
        'AADL',
        { aadl: { codeloc: AADL.payable } },
        'aadl-payable',
      );

      expect(ack.status).toBe('PENDING');
      expect(txn.status).toBe('READY');
      expect(txn.partner).toBe('AADL');
      expect(txn.currency).toBe('DZD');

      // The request nests the identifier under `aadl`; the response flattens it to a
      // single `codeloc`. Code that reads back what it sent, unchanged, is wrong here.
      expect(txn.account).toEqual({ codeloc: AADL.payable });
      expect(txn.account['aadl']).toBeUndefined();

      // One aggregate total per housing file, never a list — however far behind the
      // tenant is. A multi-select picker renders a list of one here, forever.
      expect(txn.bills).toHaveLength(1);
      const avis = txn.bills![0]!;
      expect(avis.amount).toBe(5400);
      expect(avis.fee).toBe(0);
      expect(avis.period).toBe('Août 2026');
      expect(avis.label).toBeTruthy();

      const breakdown = avis.breakdown;
      expect(breakdown).toBeDefined();
      expect(breakdown!.totalRent).toBe(5000);
      expect(breakdown!.totalCharges).toBe(400);
      expect(breakdown!.totalPenalties).toBe(0);
      expect(breakdown!.unpaidPeriods).toBe(0);
      expect(breakdown!.site).toBe('Cite Sandbox A');
      // A human label like "Le 24 du mois…", not an ISO timestamp — do not parse it.
      expect(typeof breakdown!.dueDate).toBe('string');

      // The breakdown is what a tenant is shown to explain the total, so it has to add
      // up to the total they are asked to pay.
      const components =
        (breakdown!.totalRent ?? 0) +
        (breakdown!.totalCharges ?? 0) +
        (breakdown!.totalPenalties ?? 0);
      expect(components).toBe(avis.amount);
    },
    NET,
  );

  it(
    'the arrears file folds two unpaid periods into one avis, and pays whole',
    async () => {
      const d = await discoverReady('AADL', { aadl: { codeloc: AADL.arrears } }, 'aadl-arrears');

      expect(d.txn.status).toBe('READY');
      expect(d.txn.account).toEqual({ codeloc: AADL.arrears });
      expect(d.txn.bills).toHaveLength(1);

      const avis = d.txn.bills![0]!;
      expect(avis.amount).toBe(12000);
      expect(avis.fee).toBe(0);
      expect(avis.period).toBe('Juillet 2026');

      const breakdown = avis.breakdown!;
      expect(breakdown).toBeDefined();
      expect(breakdown.unpaidPeriods).toBe(2);
      expect(breakdown.totalRent).toBe(10000);
      expect(breakdown.totalCharges).toBe(800);
      expect(breakdown.totalPenalties).toBe(1200);
      expect(breakdown.site).toBe('Cite Sandbox B');
      expect(
        (breakdown.totalRent ?? 0) +
          (breakdown.totalCharges ?? 0) +
          (breakdown.totalPenalties ?? 0),
      ).toBe(avis.amount);

      // None of it is separately payable: the one entry settles the whole file.
      const { settled } = await payFirstBill(d);
      expect(settled.status).toBe('SUCCESS');
      expect(settled.total).toBe(avis.amount + avis.fee);

      // The explanation the tenant was shown survives onto the paid transaction, which
      // is what a reconciliation job and a dispute both end up reading.
      expect(settled.selectedBill?.breakdown?.unpaidPeriods).toBe(2);
    },
    ROUND_TRIP,
  );

  it(
    'a file with no open avis is READY with nothing payable, and paying it is a 404',
    async () => {
      const { txn } = await discoverReady(
        'AADL',
        { aadl: { codeloc: AADL.nothingDue } },
        'aadl-nothing-due',
      );

      // "Nothing payable", not an error and not "nothing owed" — READY with an empty
      // array is a successful discovery.
      expect(txn.status).toBe('READY');
      expect(txn.bills).toEqual([]);
      expect(txn.error).toBeUndefined();

      const e = await rejection<BillPayNotFoundError>(
        client().bills.pay({
          transactionId: txn.transactionId,
          billId: `sbx_bill_${txn.transactionId}_0`,
          ref: mintRef('aadl-nothing-due-pay'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayNotFoundError);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.httpStatus).toBe(404);
    },
    NET,
  );

  it(
    'an already-settled file is refused at discovery with 409 BILL_ALREADY_PAID',
    async () => {
      // Refused synchronously — there is no transaction to poll, so an integration
      // that only handles failures by polling never sees this one.
      const e = await rejection<BillPayConflictError>(
        client().bills.discover({
          partner: 'AADL',
          account: { aadl: { codeloc: AADL.settled } },
          ref: mintRef('aadl-settled'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayConflictError);
      expect(e.code).toBe('BILL_ALREADY_PAID');
      expect(e.httpStatus).toBe(409);
      expect(e.requestId).toBeTruthy();
      expect(e.isRetryable).toBe(false);
    },
    NET,
  );

  it(
    'discover → pay → SUCCESS → receipt, end to end',
    async () => {
      const c = client();
      const d = await discoverReady('AADL', { aadl: { codeloc: AADL.payable } }, 'aadl-round-trip');
      const bill = d.txn.bills![0]!;

      const { ack, settled, payRef } = await payFirstBill(d);
      expect(ack.status).toBe('PROCESSING');
      expect(ack.transactionId).toBe(d.txn.transactionId);
      // The acknowledgement echoes the DISCOVERY ref. The pay ref is validated, then
      // discarded — this is the whole reason `getByRef(payRef)` never resolves.
      expect(ack.ref).toBe(d.ref);
      expect(ack.ref).not.toBe(payRef);

      expect(settled.status).toBe('SUCCESS');
      expect(settled.type).toBe('payment');
      expect(settled.selectedBill?.billId).toBe(bill.billId);
      expect(settled.operationId).toBeTruthy();
      expect(settled.completedAt).toBeTruthy();
      expect(settled.error).toBeUndefined();

      // Sandbox charges no fee, so `total === amount` here and an integration that
      // quietly bills `amount` looks correct right up until production.
      expect(settled.total).toBe(bill.amount + bill.fee);
      expect(bill.fee).toBe(0);

      const receipt = await c.bills.receipt(d.txn.transactionId);
      expect(receipt.bytes.byteLength).toBeGreaterThan(0);
      expect(receipt.contentType).toMatch(/pdf|png|jpeg|octet-stream/);
      expect(receipt.filename).toBeTruthy();

      // `avis` is documented but not routed in this deployment yet, so assert the
      // degradation contract rather than the absence: either a document comes back, or
      // Fastify's bare `{ message, error, statusCode }` body — no `success` field at
      // all — surfaces as an ordinary typed 404. What it must never be is a decoding
      // complaint about a response nobody asked the caller to read.
      const outcome = await c.bills.avis(d.txn.transactionId).catch((e: unknown) => e);
      if (outcome instanceof BillPayError) {
        expect(outcome).toBeInstanceOf(BillPayNotFoundError);
        expect(outcome.code).toBe('NOT_FOUND');
        expect(outcome.httpStatus).toBe(404);
        expect(outcome.message).toBeTruthy();

        // The reason a caller can write this branch once and never revisit it: today
        // the refusal never reaches the application, so it is flagged as a missing
        // endpoint rather than as an answer about this transaction. This transaction
        // is AADL and has resolved a housing file, so the only honest reading of a
        // 404 here is "not deployed yet".
        expect(outcome.enveloped).toBe(false);
        expect(outcome.isEndpointMissing).toBe(true);
      } else {
        const avis = outcome as Avis;
        expect(avis.bytes.byteLength).toBeGreaterThan(0);
        expect(avis.contentType).toContain('pdf');
        expect(avis.filename).toMatch(/\.pdf$/);
      }
    },
    ROUND_TRIP,
  );
});

// ─── ADE ──────────────────────────────────────────────────────────────────────

describe.skipIf(!liveAde)('ADE — discovery outcomes', () => {
  it(
    'the happy path is READY with one 443.39 DZD bill',
    async () => {
      const { ack, txn } = await discoverReady('ADE', { reference: ADE.happy }, 'ade-happy');

      expect(ack.status).toBe('PENDING');
      expect(ack.transactionId).toMatch(/^[0-9a-f]{24}$/);
      expect(txn.status).toBe('READY');
      expect(txn.type).toBe('discovery');
      expect(txn.account).toEqual({ reference: ADE.happy });
      expect(txn.bills).toHaveLength(1);
      expect(txn.bills![0]!.amount).toBe(443.39);
      expect(txn.bills![0]!.fee).toBe(0);
      // Only AADL publishes one today; nothing else may assume it exists.
      expect(txn.bills![0]!.breakdown).toBeUndefined();
    },
    NET,
  );

  it(
    'nothing due is READY with an empty bills array, not an error',
    async () => {
      const { txn } = await discoverReady('ADE', { reference: ADE.nothingDue }, 'ade-nothing-due');

      expect(txn.status).toBe('READY');
      expect(txn.bills).toEqual([]);
      expect(txn.error).toBeUndefined();
    },
    NET,
  );

  it(
    'a balance under the 200 DZD floor discovers as nothing payable',
    async () => {
      const { txn } = await discoverReady('ADE', { reference: ADE.underFloor }, 'ade-under-floor');

      // Indistinguishable from "nothing due" on the wire, and that is the point: the
      // customer is told nothing is payable, never that nothing is owed.
      expect(txn.status).toBe('READY');
      expect(txn.bills).toEqual([]);
    },
    NET,
  );

  it(
    'a malformed reference is 400 INVALID_ACCOUNT — the one to show the customer',
    async () => {
      const e = await rejection<BillPayValidationError>(
        client().bills.discover({
          partner: 'ADE',
          account: { reference: ADE.malformed },
          ref: mintRef('ade-malformed'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayValidationError);
      expect(e.code).toBe('INVALID_ACCOUNT');
      expect(e.httpStatus).toBe(400);
      expect(e.requestId).toBeTruthy();
    },
    NET,
  );

  it(
    'an unreachable biller is 503 PARTNER_UNAVAILABLE, and nothing was started',
    async () => {
      const e = await rejection<BillPayUnavailableError>(
        client().bills.discover({
          partner: 'ADE',
          account: { reference: ADE.unreachable },
          ref: mintRef('ade-unreachable'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayUnavailableError);
      expect(e).not.toBeInstanceOf(BillPayAuthError);
      expect(e.code).toBe('PARTNER_UNAVAILABLE');
      expect(e.httpStatus).toBe(503);
      expect(e.isRetryable).toBe(true);
    },
    NET,
  );

  it(
    'the 24-hour already-paid guard is 409 BILL_ALREADY_PAID',
    async () => {
      const e = await rejection<BillPayConflictError>(
        client().bills.discover({
          partner: 'ADE',
          account: { reference: ADE.alreadyPaid },
          ref: mintRef('ade-already-paid'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayConflictError);
      expect(e.code).toBe('BILL_ALREADY_PAID');
      expect(e.httpStatus).toBe(409);
    },
    NET,
  );

  it(
    'reusing a live ref for the same partner is 403 DUPLICATED_REF',
    async () => {
      const c = client();
      const ref = mintRef('ade-duplicate');

      const first = await withRateLimitRetry(() =>
        c.bills.discover({ partner: 'ADE', account: { reference: ADE.happy }, ref }),
      );
      expect(first.ref).toBe(ref);

      const e = await rejection<BillPayConflictError>(
        c.bills.discover({ partner: 'ADE', account: { reference: ADE.happy }, ref }),
      );

      expect(e).toBeInstanceOf(BillPayConflictError);
      expect(e.code).toBe('DUPLICATED_REF');
      expect(e.httpStatus).toBe(403);

      // The guard is answered by looking the ref up, never by resending with a new one —
      // retrying around it is how a customer gets charged twice.
      const recovered = await c.bills.getByRef({ ref, partner: 'ADE' });
      expect(recovered.transactionId).toBe(first.transactionId);
    },
    NET,
  );
});

describe.skipIf(!liveAde)('ADE — payment outcomes', () => {
  it(
    'the happy path pays to SUCCESS and the receipt downloads',
    async () => {
      const c = client();
      const d = await discoverReady('ADE', { reference: ADE.happy }, 'ade-pay-success');
      const bill = d.txn.bills![0]!;

      const { ack, settled } = await payFirstBill(d);
      expect(ack.status).toBe('PROCESSING');
      expect(settled.status).toBe('SUCCESS');
      expect(settled.total).toBe(bill.amount + bill.fee);
      expect(settled.receiptUrl).toBeTruthy();

      const receipt = await c.bills.receipt(d.txn.transactionId);
      expect(receipt.bytes.byteLength).toBeGreaterThan(0);
      expect(receipt.contentType).toMatch(/pdf|png|jpeg|octet-stream/);
    },
    ROUND_TRIP,
  );

  it(
    'a declined payment settles FAILED with PAYMENT_DECLINED and no debit',
    async () => {
      const d = await discoverReady('ADE', { reference: ADE.declined }, 'ade-declined');
      expect(d.txn.bills![0]!.amount).toBe(400);

      const { settled } = await payFirstBill(d);
      expect(settled.status).toBe('FAILED');
      expect(isTerminal(settled.status)).toBe(true);
      expect(settled.error?.code).toBe('PAYMENT_DECLINED');
      expect(settled.error?.message).toBeTruthy();
      // Nothing moved, so there is nothing to receipt.
      expect(settled.receiptUrl).toBeUndefined();
    },
    ROUND_TRIP,
  );

  it(
    'a late failure settles REFUNDED — money that moved and came back',
    async () => {
      const d = await discoverReady('ADE', { reference: ADE.refunded }, 'ade-refunded');
      expect(d.txn.bills![0]!.amount).toBe(550);

      const { settled } = await payFirstBill(d);
      expect(settled.status).toBe('REFUNDED');
      expect(isTerminal(settled.status)).toBe(true);
      expect(settled.error?.code).toBe('PAYMENT_DECLINED');
    },
    ROUND_TRIP,
  );

  it(
    'the nested ade{} invoice form is a distinct identifier slot, debited then reversed',
    async () => {
      const d = await discoverReady('ADE', { ade: ADE_INVOICE }, 'ade-invoice-refund');

      // Sent nested, echoed flat as `reference` — the same flattening AADL does.
      expect(d.txn.account['reference']).toBeTruthy();
      expect(d.txn.account['ade']).toBeUndefined();
      expect(d.txn.bills![0]!.amount).toBe(600);

      const { settled } = await payFirstBill(d);
      expect(settled.status).toBe('REFUNDED');
      expect(settled.error?.code).toBe('PAYMENT_DECLINED');
    },
    ROUND_TRIP,
  );

  it(
    'paying a billId the transaction never held is 404 NOT_FOUND',
    async () => {
      const d = await discoverReady('ADE', { reference: ADE.happy }, 'ade-unknown-bill');
      expect(d.txn.bills).toHaveLength(1);

      const e = await rejection<BillPayNotFoundError>(
        client().bills.pay({
          transactionId: d.txn.transactionId,
          billId: `sbx_bill_${d.txn.transactionId}_99`,
          ref: mintRef('ade-unknown-bill-pay'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayNotFoundError);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.httpStatus).toBe(404);
      expect(e.message).toContain('not found');
    },
    ROUND_TRIP,
  );
});

// ─── SONELGAZ ─────────────────────────────────────────────────────────────────

describe.skipIf(!liveSonelgaz)('SONELGAZ — the multi-bill partner', () => {
  it(
    'a nested invoice returns two separately payable bills',
    async () => {
      const { txn } = await discoverReady('SONELGAZ', { sonelgaz: SONELGAZ.multi }, 'sg-multi');

      expect(txn.status).toBe('READY');
      expect(txn.bills).toHaveLength(2);
      expect(txn.bills!.map((b) => b.amount)).toEqual([1200, 850]);
      // Sent as `sonelgaz{}`, echoed flat as `contractNumber`.
      expect(txn.account).toEqual({ contractNumber: SONELGAZ.multi.invoice_number });
      // Distinct ids: this is the one partner where a picker is the right screen.
      expect(new Set(txn.bills!.map((b) => b.billId)).size).toBe(2);
    },
    NET,
  );

  it(
    'everything under the floor discovers as nothing payable',
    async () => {
      const { txn } = await discoverReady(
        'SONELGAZ',
        { sonelgaz: SONELGAZ.underFloor },
        'sg-under-floor',
      );

      expect(txn.status).toBe('READY');
      expect(txn.bills).toEqual([]);
    },
    NET,
  );

  it(
    'the review scenario holds UNKNOWN for about a minute, then settles REFUNDED',
    async () => {
      // The most important test in the suite and the slowest: it is the only cheap way
      // to prove the poller does not refund a customer whose payment was actually
      // taken. `UNKNOWN` is not terminal, and treating it as a failure is the single
      // most expensive mistake an integration can make.
      const c = client();
      const d = await discoverReady('SONELGAZ', { sonelgaz: SONELGAZ.review }, 'sg-review');
      expect(d.txn.bills![0]!.amount).toBe(900);

      const bill = d.txn.bills![0]!;
      await withRateLimitRetry(() =>
        c.bills.pay({
          transactionId: d.txn.transactionId,
          billId: bill.billId,
          ref: payRefFor(d.ref),
        }),
      );

      // Watch the statuses the API really goes through while `waitForTerminal` runs,
      // so the assertion is that the SDK held through a state it actually saw.
      const seen = new Set<TransactionStatus>();
      let finished = false;
      const observe = (async () => {
        while (!finished) {
          const t = await c.bills.get(d.txn.transactionId);
          seen.add(t.status);
          if (isTerminal(t.status)) return;
          await sleep(5_000);
        }
      })();

      const settled = await c.bills.waitForTerminal(d.txn.transactionId, {
        timeoutMs: 180_000,
        intervalMs: 3_000,
        maxIntervalMs: 5_000,
      });
      finished = true;
      await observe;

      expect(seen.has('UNKNOWN')).toBe(true);
      expect(isTerminal('UNKNOWN')).toBe(false);
      expect(settled.status).toBe('REFUNDED');
      expect(settled.error?.code).toBe('PAYMENT_DECLINED');
    },
    REVIEW,
  );
});

// ─── Algérie Télécom ──────────────────────────────────────────────────────────

describe.skipIf(!liveTelecom)('Algérie Télécom — the landline row', () => {
  it(
    'an accented partner name round-trips and the landline discovers one bill',
    async () => {
      const { txn } = await discoverReady('Algérie Télécom', { phoneNumber: LANDLINE }, 'at-line');

      // The partner name comes back exactly as sent, accents and all. Anything that
      // slugs or normalises it on the way through breaks here.
      expect(txn.partner).toBe('Algérie Télécom');
      expect(txn.status).toBe('READY');
      expect(txn.account).toEqual({ phoneNumber: LANDLINE });
      expect(txn.bills).toHaveLength(1);
      expect(txn.bills![0]!.amount).toBe(300);

      // Non-terminal, nothing paid, no selectedBill — and `completedAt` is set anyway.
      // The field marks when the current phase stopped working, not when the
      // transaction finished, so `if (txn.completedAt) markSettled(txn)` drops an unpaid
      // discovery out of the queue. Branch on `status`.
      expect(isTerminal(txn.status)).toBe(false);
      expect(txn.completedAt).toBeTruthy();
      expect(txn.selectedBill).toBeUndefined();
    },
    NET,
  );

  it(
    'refuses the international spelling of the same landline',
    async () => {
      // The one per-field format the SDK states precisely, so it is worth stating
      // correctly: `+213…` is not an accepted way to write `023456789`. A front end that
      // normalises phone input to E.164 gets ERR_VALIDATION — a code the SDK's own docs
      // say to log and never show the customer, on a number they typed correctly.
      const e = await rejection<BillPayValidationError>(
        client().bills.discover({
          partner: 'Algérie Télécom',
          account: { phoneNumber: '+21323456789' },
          ref: mintRef('at-e164'),
        }),
      );

      expect(e).toBeInstanceOf(BillPayValidationError);
      expect(e.code).toBe('ERR_VALIDATION');
      expect(e.httpStatus).toBe(400);
    },
    NET,
  );
});

// ─── SEAAL ────────────────────────────────────────────────────────────────────

describe.skipIf(!liveSeaal)('SEAAL — the pair goes out, one flat key comes home', () => {
  it(
    'the code_client/code_contrat pair discovers several quarters and echoes codeClient',
    async () => {
      // The two facts that make SEAAL unlike every other row in this file: the request
      // identifier is a nested pair, and the response flattens it to `codeClient` — not
      // to `reference`, which is ADE's and which this suite wrongly asserted for SEAAL
      // for as long as the biller was switched off and the assertion never ran.
      const { ack, txn } = await discoverReady('SEAAL', { seaal: SEAAL.quarters }, 'seaal-pair');

      expect(ack.status).toBe('PENDING');
      expect(txn.status).toBe('READY');
      expect(txn.partner).toBe('SEAAL');
      expect(txn.account).toEqual({ codeClient: SEAAL.quarters.code_client });

      // Water is billed quarterly and nothing forces a household to settle each quarter
      // as it lands, so a list — not a single aggregate — is the normal answer here, and
      // every entry is separately payable. In production `billId` is the invoice number
      // (`numero_fac`, e.g. `F059107046`); the sandbox mints its own, which is exactly
      // why this asserts the ids are distinct and non-empty rather than their shape.
      expect(txn.bills!.length).toBeGreaterThan(1);
      const ids = txn.bills!.map((b) => b.billId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const bill of txn.bills!) {
        expect(bill.billId).not.toBe('');
        expect(bill.amount).toBeGreaterThan(0);
      }
    },
    NET,
  );

  it(
    'a fully settled account is READY with an empty list, not an error',
    async () => {
      // SEAAL's reconciliation signal is absence: a paid facture stops being returned.
      // So "nothing outstanding" arrives as a result, and an integration that treats an
      // empty list as a failure tells a paid-up customer their account is broken.
      const { txn } = await discoverReady('SEAAL', { seaal: SEAAL.settled }, 'seaal-settled');

      expect(txn.status).toBe('READY');
      expect(txn.bills).toEqual([]);
      expect(txn.error).toBeUndefined();
    },
    NET,
  );
});

// ─── Lookup and recovery ──────────────────────────────────────────────────────

describe.skipIf(!liveAde)('lookup and recovery', () => {
  it(
    'by-ref resolves the discovery ref before and after a payment, and 404s on the pay ref',
    async () => {
      const c = client();
      const ref = mintRef('ade-by-ref');
      const ack = await withRateLimitRetry(() =>
        c.bills.discover({ partner: 'ADE', account: { reference: ADE.happy }, ref }),
      );

      // The documented recovery path: pretend the POST response was lost and find the
      // transaction again using only the ref you chose before you sent it.
      const recovered = await c.bills.getByRef({ ref, partner: 'ADE' });
      expect(recovered.transactionId).toBe(ack.transactionId);
      expect(recovered.ref).toBe(ref);

      const ready = await c.bills.waitForReady(ack.transactionId, { timeoutMs: 45_000 });
      const payRef = payRefFor(ref);
      await withRateLimitRetry(() =>
        c.bills.pay({
          transactionId: ack.transactionId,
          billId: ready.bills![0]!.billId,
          ref: payRef,
        }),
      );

      // The transaction keeps its discovery ref through the payment.
      const afterPay = await c.bills.getByRef({ ref, partner: 'ADE' });
      expect(afterPay.transactionId).toBe(ack.transactionId);
      expect(afterPay.ref).toBe(ref);

      // The pay ref was validated and thrown away, so it resolves to nothing. Reaching
      // for it during recovery is the mistake this asserts against.
      const e = await rejection<BillPayNotFoundError>(
        c.bills.getByRef({ ref: payRef, partner: 'ADE' }),
      );
      expect(e).toBeInstanceOf(BillPayNotFoundError);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.httpStatus).toBe(404);
    },
    ROUND_TRIP,
  );

  it(
    'a transaction id that is not yours is 404, never 403',
    async () => {
      // Well-formed and almost certainly someone else's, or nobody's. The API never
      // confirms an id exists, so this reads as "check the id and the key", not as
      // "access denied" — and nothing should branch on it as a permissions problem.
      const e = await rejection<BillPayNotFoundError>(
        client().bills.get('0123456789abcdef01234567'),
      );

      expect(e).toBeInstanceOf(BillPayNotFoundError);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.httpStatus).toBe(404);
    },
    NET,
  );

  it(
    'list omits bills, so get is the only way to read them',
    async () => {
      const c = client();
      const { txn } = await discoverReady('ADE', { reference: ADE.happy }, 'ade-list-projection');

      const byId = await c.bills.get(txn.transactionId);
      expect(byId.bills).toHaveLength(1);

      const listed = (await c.bills.list({ limit: 20 })).transactions.find(
        (t) => t.transactionId === txn.transactionId,
      );

      // A server-side projection, not an SDK quirk: the same READY row lists with an
      // empty `bills` however many it holds. Rendering a list page straight from this
      // shows every customer "nothing payable".
      expect(listed).toBeDefined();
      expect(listed!.status).toBe('READY');
      expect(listed!.bills).toEqual([]);
    },
    ROUND_TRIP,
  );
});

describe.skipIf(!live)('listing', () => {
  it(
    'pagination is carried by meta, because data is a bare array',
    async () => {
      const c = client();

      const page1 = await c.bills.list({ limit: 2, offset: 0 });
      expect(Array.isArray(page1.transactions)).toBe(true);
      expect(page1.transactions.length).toBeLessThanOrEqual(2);
      // `total`, `limit` and `offset` exist nowhere in the body — the SDK lifts them out
      // of the envelope's `meta`, which is exactly why `meta` may not be dropped.
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);
      expect(page1.total).toBeGreaterThanOrEqual(page1.transactions.length);

      if (page1.total < 3) {
        console.info(
          `[integration] SKIPPING the second page — this account holds ${page1.total} ` +
            `transaction(s), so there is no page to compare against.`,
        );
        return;
      }

      const page2 = await c.bills.list({ limit: 2, offset: 2 });
      expect(page2.limit).toBe(2);
      expect(page2.offset).toBe(2);
      // The suite itself is still adding rows, so the total only ever grows.
      expect(page2.total).toBeGreaterThanOrEqual(page1.total);

      const firstPageIds = new Set(page1.transactions.map((t) => t.transactionId));
      expect(page2.transactions.some((t) => firstPageIds.has(t.transactionId))).toBe(false);
    },
    NET,
  );
});
