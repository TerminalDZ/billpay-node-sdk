/**
 * Integration suite — runs against the local stack only.
 *
 * Start it with `billPayManager/scripts/run-local.ps1 up`. When nothing is listening
 * the whole suite skips with a message; it never fails the build for a missing stack,
 * and it is never pointed at production.
 *
 * Every scenario mints a fresh `ref`, so the suite is re-runnable against the same
 * database without tripping `DUPLICATED_REF`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  BillPayAuthError,
  BillPayClient,
  BillPayConflictError,
  BillPayNotFoundError,
  BillPayUnavailableError,
  BillPayValidationError,
  newRef,
  payRefFor,
  type AccountIdentifier,
  type Partner,
  type Transaction,
} from '../../src/index.js';

const BASE_URL = process.env.BILLPAY_BASE_URL ?? 'http://localhost:3100';
const SANDBOX_KEY = 'sk_sbx_partner_a';

let reachable = false;

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/v3/validate`, {
      headers: { 'X-Access-Token': SANDBOX_KEY },
      signal: AbortSignal.timeout(3000),
    });
    reachable = res.status === 200;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.warn(
      `\n[integration] SKIPPED — no API at ${BASE_URL}.\n` +
        `[integration] Start it with: cd billPayManager && .\\scripts\\run-local.ps1 up\n`,
    );
  }
});

const client = (apiKey = SANDBOX_KEY): BillPayClient =>
  new BillPayClient({ apiKey, baseUrl: BASE_URL, timeoutMs: 15_000 });

/** Run a full discovery and return the READY transaction. */
const discoverReady = async (
  partner: Partner,
  account: AccountIdentifier,
): Promise<{ txn: Transaction; ref: string }> => {
  const ref = newRef('it');
  const ack = await client().bills.discover({ partner, account, ref });
  expect(ack.status).toBe('PENDING');
  const txn = await client().bills.waitForReady(ack.transactionId, { timeoutMs: 60_000 });
  return { txn, ref };
};

/** Vitest lacks a runtime "skip all", so each test guards on reachability. */
const need = (): boolean => {
  if (!reachable) expect(true).toBe(true);
  return reachable;
};

describe('auth', () => {
  it('validate returns the identity and SANDBOX key type', async () => {
    if (!need()) return;
    const r = await client().validate();

    expect(r.key.type).toBe('SANDBOX');
    expect(r.account.id).toBeTruthy();
    expect(r.account.currency).toBe('DZD');
  });

  it('missing token → 401 MISSING_ACCESS_TOKEN', async () => {
    if (!need()) return;
    const res = await fetch(`${BASE_URL}/v3/validate`);
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('MISSING_ACCESS_TOKEN');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('bad token → 401 INVALID_ACCESS_TOKEN', async () => {
    if (!need()) return;
    const e = await client('sk_sbx_bad')
      .validate()
      .catch((x: unknown) => x);

    expect(e).toBeInstanceOf(BillPayAuthError);
    expect((e as BillPayAuthError).code).toBe('INVALID_ACCESS_TOKEN');
  });

  it('flagged key → 401 INVALID_ACCESS_TOKEN', async () => {
    if (!need()) return;
    const e = await client('sk_sbx_flagged')
      .validate()
      .catch((x: unknown) => x);

    expect(e).toBeInstanceOf(BillPayAuthError);
    expect((e as BillPayAuthError).code).toBe('INVALID_ACCESS_TOKEN');
  });

  it('wallet without is_sandbox → 503 AUTH_UNAVAILABLE with Retry-After', async () => {
    if (!need()) return;
    const e = (await client('sk_nofield_legacy')
      .validate()
      .catch((x: unknown) => x)) as BillPayUnavailableError;

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e.code).toBe('AUTH_UNAVAILABLE');
    expect(e.httpStatus).toBe(503);
    expect(e.retryAfter).toBe(5);
    // Explicitly NOT an auth failure — the key is fine.
    expect(e).not.toBeInstanceOf(BillPayAuthError);
  });
});

describe('partners', () => {
  it('reports SEAAL and AADL unavailable and the rest active', async () => {
    if (!need()) return;
    const p = await client().partners();

    expect(p['SEAAL']?.status).toBe('UNAVAILABLE');
    expect(p['AADL']?.status).toBe('UNAVAILABLE');
    expect(p['ADE']?.status).toBe('ACTIVE');
    expect(p['SONELGAZ']?.status).toBe('ACTIVE');
    expect(p['Algérie Télécom']?.status).toBe('ACTIVE');
  });
});

describe('discovery outcomes', () => {
  it('happy path: READY with one 443.39 DZD bill', async () => {
    if (!need()) return;
    const { txn } = await discoverReady('ADE', { reference: '0123456789012345678901234' });

    expect(txn.status).toBe('READY');
    expect(txn.bills).toHaveLength(1);
    expect(txn.bills![0]!.amount).toBe(443.39);
    expect(txn.transactionId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('multi-bill: SONELGAZ nested invoice returns two bills', async () => {
    if (!need()) return;
    const { txn } = await discoverReady('SONELGAZ', {
      sonelgaz: { invoice_number: '9876543210', amount_without_stamp: '15000', ebb_key: 'ABC123' },
    });

    expect(txn.status).toBe('READY');
    expect(txn.bills!.length).toBeGreaterThanOrEqual(2);
  });

  it('nothing due: READY with an empty bills array', async () => {
    if (!need()) return;
    const { txn } = await discoverReady('ADE', { reference: '0123456789012340000000002' });

    expect(txn.status).toBe('READY');
    expect(txn.bills).toEqual([]);
  });

  it('below the 200 DZD floor: READY with an empty bills array', async () => {
    if (!need()) return;
    const { txn } = await discoverReady('ADE', { reference: '0123456789012341111111111' });

    expect(txn.status).toBe('READY');
    expect(txn.bills).toEqual([]);
  });

  it('invalid account → 400 INVALID_ACCOUNT', async () => {
    if (!need()) return;
    const e = (await client()
      .bills.discover({
        partner: 'ADE',
        account: { reference: 'abc0000000000000000000000' },
        ref: newRef('it'),
      })
      .catch((x: unknown) => x)) as BillPayValidationError;

    expect(e).toBeInstanceOf(BillPayValidationError);
    expect(e.code).toBe('INVALID_ACCOUNT');
    expect(e.httpStatus).toBe(400);
  });

  it('disabled partner → 503 PARTNER_UNAVAILABLE', async () => {
    if (!need()) return;
    const e = (await client()
      .bills.discover({ partner: 'AADL', account: { aadlNumber: '1112223334' }, ref: newRef('it') })
      .catch((x: unknown) => x)) as BillPayUnavailableError;

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e.code).toBe('PARTNER_UNAVAILABLE');
    expect(e.httpStatus).toBe(503);
  });

  it('already paid → 409 BILL_ALREADY_PAID', async () => {
    if (!need()) return;
    const e = (await client()
      .bills.discover({
        partner: 'ADE',
        account: { reference: '0123456789012347777777777' },
        ref: newRef('it'),
      })
      .catch((x: unknown) => x)) as BillPayConflictError;

    expect(e).toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('BILL_ALREADY_PAID');
    expect(e.httpStatus).toBe(409);
  });

  it('reusing a live ref → 403 DUPLICATED_REF', async () => {
    if (!need()) return;
    const ref = newRef('it-dup');
    const account: AccountIdentifier = { reference: '0123456789012345678901234' };

    await client().bills.discover({ partner: 'ADE', account, ref });
    const e = (await client()
      .bills.discover({ partner: 'ADE', account, ref })
      .catch((x: unknown) => x)) as BillPayConflictError;

    expect(e).toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('DUPLICATED_REF');
    expect(e.httpStatus).toBe(403);
  });
});

describe('payment outcomes', () => {
  it('happy path pays to SUCCESS and the receipt downloads', async () => {
    if (!need()) return;
    const c = client();
    const { txn, ref } = await discoverReady('ADE', { reference: '0123456789012345678901234' });

    const ack = await c.bills.pay({
      transactionId: txn.transactionId,
      billId: txn.bills![0]!.billId,
      ref: payRefFor(ref),
    });
    expect(ack.status).toBe('PROCESSING');
    // The ack echoes the DISCOVERY ref, not the pay ref we just sent.
    expect(ack.ref).toBe(ref);

    const done = await c.bills.waitForTerminal(txn.transactionId, { timeoutMs: 90_000 });
    expect(done.status).toBe('SUCCESS');
    expect(done.receiptUrl).toBeTruthy();

    const receipt = await c.bills.receipt(txn.transactionId);
    expect(receipt.bytes.byteLength).toBeGreaterThan(0);
    expect(receipt.contentType).toMatch(/pdf|png|jpeg|octet-stream/);
  });

  it('declined account settles as FAILED with PAYMENT_DECLINED', async () => {
    if (!need()) return;
    const c = client();
    const { txn, ref } = await discoverReady('ADE', { reference: '0123456789012340000000004' });

    await c.bills.pay({
      transactionId: txn.transactionId,
      billId: txn.bills![0]!.billId,
      ref: payRefFor(ref),
    });

    const done = await c.bills.waitForTerminal(txn.transactionId, { timeoutMs: 90_000 });
    expect(done.status).toBe('FAILED');
    expect(done.error?.code).toBe('PAYMENT_DECLINED');
  });

  it('refunded account settles as REFUNDED', async () => {
    if (!need()) return;
    const c = client();
    const { txn, ref } = await discoverReady('ADE', { reference: '0123456789012340000000005' });

    await c.bills.pay({
      transactionId: txn.transactionId,
      billId: txn.bills![0]!.billId,
      ref: payRefFor(ref),
    });

    const done = await c.bills.waitForTerminal(txn.transactionId, { timeoutMs: 120_000 });
    expect(done.status).toBe('REFUNDED');
  });

  it('under review: the poller holds through UNKNOWN and settles REFUNDED', async () => {
    if (!need()) return;
    const c = client();
    const { txn, ref } = await discoverReady('SONELGAZ', {
      sonelgaz: { invoice_number: '6006006006', amount_without_stamp: '15000', ebb_key: 'ABC123' },
    });

    await c.bills.pay({
      transactionId: txn.transactionId,
      billId: txn.bills![0]!.billId,
      ref: payRefFor(ref),
    });

    // Observe UNKNOWN directly, then confirm the poller does not stop on it.
    const seen = new Set<string>();
    const done = await (async () => {
      for (;;) {
        const t = await c.bills.get(txn.transactionId);
        seen.add(t.status);
        if (t.status === 'SUCCESS' || t.status === 'FAILED' || t.status === 'REFUNDED') return t;
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();

    expect(seen.has('UNKNOWN')).toBe(true);
    expect(done.status).toBe('REFUNDED');
  }, 180_000);
});

describe('lookup and recovery', () => {
  it('by-ref resolves the discovery ref, and 404s on the pay ref', async () => {
    if (!need()) return;
    const c = client();
    const { txn, ref } = await discoverReady('ADE', { reference: '0123456789012345678901234' });
    const pref = payRefFor(ref);

    await c.bills.pay({
      transactionId: txn.transactionId,
      billId: txn.bills![0]!.billId,
      ref: pref,
    });

    const found = await c.bills.getByRef({ ref, partner: 'ADE' });
    expect(found.transactionId).toBe(txn.transactionId);

    // The pay ref is validated then discarded — it never resolves.
    const e = await c.bills.getByRef({ ref: pref, partner: 'ADE' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BillPayNotFoundError);
  });

  it('by-ref is the documented recovery path after a discover', async () => {
    if (!need()) return;
    const c = client();
    const ref = newRef('it-recover');
    await c.bills.discover({
      partner: 'ADE',
      account: { reference: '0123456789012345678901234' },
      ref,
    });

    // Pretend the POST response was lost: recover using only the ref we sent.
    const recovered = await c.bills.getByRef({ ref, partner: 'ADE' });
    expect(recovered.ref).toBe(ref);
  });

  it('an unknown transaction id returns 404, not 403', async () => {
    if (!need()) return;
    const e = await client()
      .bills.get('0123456789abcdef01234567')
      .catch((x: unknown) => x);

    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect((e as BillPayNotFoundError).httpStatus).toBe(404);
  });

  it('a transaction from another environment is invisible: 404, not 403', async () => {
    if (!need()) return;
    const { txn } = await discoverReady('ADE', { reference: '0123456789012345678901234' });

    // Same partner, different key type — the API scopes by uid AND keyType.
    const e = await client('sk_live_partner_a')
      .bills.get(txn.transactionId)
      .catch((x: unknown) => x);

    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect((e as BillPayNotFoundError).httpStatus).toBe(404);
  });

  it('list returns a bare array with counts in meta', async () => {
    if (!need()) return;
    const r = await client().bills.list({ limit: 5 });

    expect(Array.isArray(r.transactions)).toBe(true);
    expect(typeof r.total).toBe('number');
    expect(r.limit).toBe(5);
  });

  it('DRIFT: list omits bills; get returns them', async () => {
    if (!need()) return;
    // billPayManager/src/services/transaction.service.ts:37 — HISTORY_PROJECTION has
    // no `bills`, so a READY row lists as `bills: []` however many bills it holds.
    const c = client();
    const { txn } = await discoverReady('ADE', { reference: '0123456789012345678901234' });

    const byId = await c.bills.get(txn.transactionId);
    expect(byId.bills).toHaveLength(1);

    const listed = (await c.bills.list({ limit: 50 })).transactions.find(
      (t) => t.transactionId === txn.transactionId,
    );
    expect(listed).toBeDefined();
    expect(listed!.bills).toEqual([]);
  });
});
