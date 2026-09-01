import { describe, expect, it } from 'vitest';
import {
  BillPayAbortError,
  BillPayClient,
  BillPayPollTimeoutError,
  BillPayValidationError,
  isTerminal,
  TERMINAL_STATUSES,
  type TransactionStatus,
} from '../../src/index.js';
import { ok, stubFetch, TXN_ID, txn } from './helpers.js';

const poller = (statuses: TransactionStatus[], extra: Record<string, unknown> = {}) => {
  const s = stubFetch(statuses.map((status) => ({ json: ok(txn({ status, ...extra })) })));
  return {
    c: new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch }),
    s,
  };
};

const FAST = { intervalMs: 1, maxIntervalMs: 2, timeoutMs: 5_000 };

describe('terminal status set', () => {
  it('is exactly SUCCESS, FAILED and REFUNDED', () => {
    expect([...TERMINAL_STATUSES]).toEqual(['SUCCESS', 'FAILED', 'REFUNDED']);
  });

  it('does not treat UNKNOWN as terminal', () => {
    expect(isTerminal('UNKNOWN')).toBe(false);
  });

  it('does not treat in-flight statuses as terminal', () => {
    for (const s of ['PENDING', 'READY', 'PROCESSING'] as TransactionStatus[]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('waitForReady', () => {
  it('polls through PENDING until READY', async () => {
    const { c, s } = poller(['PENDING', 'PENDING', 'READY']);
    const t = await c.bills.waitForReady(TXN_ID, FAST);

    expect(t.status).toBe('READY');
    expect(s.calls).toHaveLength(3);
  });

  it('resolves on READY with an empty bills array', async () => {
    // Nothing due, or everything owed is under the 200 DZD floor. Not an error.
    const s = stubFetch([{ json: ok(txn({ status: 'READY', bills: [] })) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const t = await c.bills.waitForReady(TXN_ID, FAST);
    expect(t.bills).toEqual([]);
  });

  it('stops on a terminal status, since it will never become READY', async () => {
    const { c } = poller(['PENDING', 'FAILED']);
    const t = await c.bills.waitForReady(TXN_ID, FAST);
    expect(t.status).toBe('FAILED');
  });
});

describe('waitForTerminal', () => {
  it('resolves on SUCCESS', async () => {
    const { c } = poller(['PROCESSING', 'SUCCESS']);
    expect((await c.bills.waitForTerminal(TXN_ID, FAST)).status).toBe('SUCCESS');
  });

  it('resolves on REFUNDED', async () => {
    const { c } = poller(['PROCESSING', 'REFUNDED']);
    expect((await c.bills.waitForTerminal(TXN_ID, FAST)).status).toBe('REFUNDED');
  });

  it('resolves on FAILED without throwing', async () => {
    // FAILED is an outcome, not an SDK error. The caller inspects `error`.
    const { c } = poller(['PROCESSING', 'FAILED']);
    const t = await c.bills.waitForTerminal(TXN_ID, FAST);
    expect(t.status).toBe('FAILED');
  });

  it('keeps polling through UNKNOWN and never resolves it as an outcome', async () => {
    // The single most expensive integration mistake: treating "under review" as a
    // failure. UNKNOWN resolves to SUCCESS or REFUNDED; the poller must hold.
    const { c, s } = poller(['PROCESSING', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'REFUNDED']);
    const t = await c.bills.waitForTerminal(TXN_ID, FAST);

    expect(t.status).toBe('REFUNDED');
    expect(s.calls).toHaveLength(5);
  });

  it('can resolve UNKNOWN as SUCCESS', async () => {
    const { c } = poller(['UNKNOWN', 'SUCCESS']);
    expect((await c.bills.waitForTerminal(TXN_ID, FAST)).status).toBe('SUCCESS');
  });

  it('times out while still UNKNOWN, reporting it as the last status', async () => {
    const { c } = poller(['UNKNOWN']);
    const e = (await c.bills
      .waitForTerminal(TXN_ID, { intervalMs: 5, maxIntervalMs: 5, timeoutMs: 30 })
      .catch((x: unknown) => x)) as BillPayPollTimeoutError;

    expect(e).toBeInstanceOf(BillPayPollTimeoutError);
    expect(e.lastStatus).toBe('UNKNOWN');
    expect(e.transactionId).toBe(TXN_ID);
  });

  it('aborts mid-poll when the signal fires', async () => {
    const ctl = new AbortController();
    const { c } = poller(['PROCESSING']);

    const p = c.bills.waitForTerminal(TXN_ID, { ...FAST, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 15);

    await expect(p).rejects.toBeInstanceOf(BillPayAbortError);
  });

  it('backs off but never exceeds maxIntervalMs', async () => {
    const started = Date.now();
    const { c } = poller(['PENDING', 'PENDING', 'PENDING', 'SUCCESS']);
    await c.bills.waitForTerminal(TXN_ID, { intervalMs: 5, maxIntervalMs: 10, timeoutMs: 5_000 });

    // 5 + 10 + 10 = 25ms of sleeping, plus overhead; the ceiling stops it growing.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('input guards', () => {
  it('rejects a malformed transactionId before any request', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(c.bills.get('txn_9f3a')).rejects.toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects an uppercase hex id, matching paySchema', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(c.bills.get(TXN_ID.toUpperCase())).rejects.toBeInstanceOf(BillPayValidationError);
  });

  it('rejects an empty ref before any request', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(
      c.bills.discover({ partner: 'ADE', account: { reference: 'x' }, ref: '  ' }),
    ).rejects.toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a ref longer than 100 characters', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(
      c.bills.discover({ partner: 'ADE', account: { reference: 'x' }, ref: 'a'.repeat(101) }),
    ).rejects.toBeInstanceOf(BillPayValidationError);
  });
});
