/**
 * The polling helpers.
 *
 * Every test here runs on `vi.useFakeTimers()`. Two reasons, and the second is the one
 * that matters: a suite that really slept through a 5-second backoff ceiling would take
 * a minute, and — more usefully — a fake clock makes the backoff schedule assertable to
 * the millisecond instead of merely "fast enough", which is the only way to catch a
 * regression that doubles the delay one step too eagerly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BillPayAbortError,
  BillPayClient,
  BillPayPollTimeoutError,
  BillPayValidationError,
  isTerminal,
  TERMINAL_STATUSES,
  type TransactionStatus,
} from '../../src/index.js';
import { ok, settled, stubFetch, TXN_ID, txn } from './helpers.js';

const poller = (statuses: TransactionStatus[], extra: Record<string, unknown> = {}) => {
  const s = stubFetch(statuses.map((status) => ({ json: ok(txn({ status, ...extra })) })));
  return {
    c: new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch }),
    s,
  };
};

/** Poll settings a test can reason about: 1s, doubling, ceiling 5s, giving up at 2min. */
const POLL = { intervalMs: 1_000, maxIntervalMs: 5_000, timeoutMs: 120_000 };

/** Milliseconds between each request, relative to the first. */
const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]!);

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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('polls through PENDING until READY', async () => {
    const { c, s } = poller(['PENDING', 'PENDING', 'READY']);

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('READY');
    expect(s.calls).toHaveLength(3);
  });

  it('resolves on READY with an empty bills array', async () => {
    // Nothing due, or everything owed is under the 200 DZD floor. Not an error.
    const { c } = poller(['READY'], { bills: [] });

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).bills).toEqual([]);
  });

  it('stops on a terminal status, since it will never become READY', async () => {
    const { c } = poller(['PENDING', 'FAILED']);

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('FAILED');
  });

  it('keeps waiting through UNKNOWN, which a discovery can also report', async () => {
    const { c } = poller(['UNKNOWN', 'UNKNOWN', 'READY']);

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('READY');
  });

  it('returns after a single request when the first read is already READY', async () => {
    const { c, s } = poller(['READY']);

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(0);

    expect((await p).status).toBe('READY');
    expect(s.calls).toHaveLength(1);
  });
});

describe('waitForTerminal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves on SUCCESS', async () => {
    const { c } = poller(['PROCESSING', 'SUCCESS']);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('SUCCESS');
  });

  it('resolves on REFUNDED', async () => {
    const { c } = poller(['PROCESSING', 'REFUNDED']);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('REFUNDED');
  });

  it('resolves on FAILED without throwing', async () => {
    // FAILED is an outcome, not an SDK error. The caller inspects `error`.
    const { c } = poller(['PROCESSING', 'FAILED'], {
      error: { code: 'PAYMENT_DECLINED', message: 'Declined by the issuer.' },
    });

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    const t = await p;
    expect(t.status).toBe('FAILED');
    expect(t.error?.code).toBe('PAYMENT_DECLINED');
  });

  it('never resolves on UNKNOWN, however long it lasts', async () => {
    // The single most expensive integration mistake: treating "under review" as a
    // failure. UNKNOWN resolves to SUCCESS or REFUNDED, so the poller must hold — and
    // must still be holding after two minutes of it.
    const { c } = poller(['UNKNOWN']);
    let outcome: unknown;

    const p = c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 10 * 60_000 }).then(
      (t) => (outcome = t.status),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(120_000);

    expect(outcome).toBeUndefined();

    // Leave nothing pending: the helper is still polling, so end the wait deliberately.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await p;
    expect(outcome).toBeInstanceOf(BillPayPollTimeoutError);
  });

  it('holds through a run of UNKNOWN and settles on the REFUNDED that follows', async () => {
    const { c, s } = poller(['PROCESSING', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'REFUNDED']);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('REFUNDED');
    expect(s.calls).toHaveLength(5);
  });

  it('can resolve UNKNOWN as SUCCESS', async () => {
    const { c } = poller(['UNKNOWN', 'SUCCESS']);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('SUCCESS');
  });
});

describe('backoff', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('doubles the interval and then holds at the ceiling', async () => {
    const { c, s } = poller([
      'PENDING',
      'PENDING',
      'PENDING',
      'PENDING',
      'PENDING',
      'PENDING',
      'SUCCESS',
    ]);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);
    await p;

    // 1s, 2s, 4s, then pinned to maxIntervalMs for as long as it takes. Unbounded
    // doubling would have the seventh read land two and a half minutes in.
    expect(gaps(s.calls.map((x) => x.at))).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  it('honours a caller-supplied interval and ceiling', async () => {
    const { c, s } = poller(['PENDING', 'PENDING', 'PENDING', 'SUCCESS']);

    const p = c.bills.waitForTerminal(TXN_ID, {
      intervalMs: 250,
      maxIntervalMs: 600,
      timeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await p;

    expect(gaps(s.calls.map((x) => x.at))).toEqual([250, 500, 600]);
  });

  it('polls on a flat schedule when the ceiling equals the interval', async () => {
    const { c, s } = poller(['PENDING', 'PENDING', 'SUCCESS']);

    const p = c.bills.waitForTerminal(TXN_ID, {
      intervalMs: 2_000,
      maxIntervalMs: 2_000,
      timeoutMs: 60_000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await p;

    expect(gaps(s.calls.map((x) => x.at))).toEqual([2_000, 2_000]);
  });
});

describe('poll deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up at timeoutMs and reports the status it last saw', async () => {
    const { c } = poller(['UNKNOWN']);

    const p = settled(c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000);

    const e = (await p) as BillPayPollTimeoutError;
    expect(e).toBeInstanceOf(BillPayPollTimeoutError);
    expect(e.code).toBe('POLL_TIMEOUT');
    expect(e.lastStatus).toBe('UNKNOWN');
    expect(e.transactionId).toBe(TXN_ID);
    // The transaction is untouched and probably still moving; this is a local give-up,
    // not a server refusal, so there is no status to report and nothing to retry.
    expect(e.httpStatus).toBeUndefined();
  });

  it('reports PROCESSING as the last status when a payment stalls', async () => {
    const { c } = poller(['PROCESSING']);

    const p = settled(c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 20_000 }));
    await vi.advanceTimersByTimeAsync(20_000);

    const e = (await p) as BillPayPollTimeoutError;
    expect(e.lastStatus).toBe('PROCESSING');
    expect(e.message).toContain('PROCESSING');
  });

  it('stops before sleeping past the deadline rather than overshooting it', async () => {
    // A poll whose next nap would land after the deadline gives up now. Sleeping first
    // and checking afterwards would make every timeout overrun by up to one interval.
    const { c, s } = poller(['PENDING']);

    const p = settled(
      c.bills.waitForTerminal(TXN_ID, {
        intervalMs: 5_000,
        maxIntervalMs: 5_000,
        timeoutMs: 12_000,
      }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBeInstanceOf(BillPayPollTimeoutError);

    // Reads at 0s and 5s; the third would wake at 10s but the deadline is 12s away and
    // the one after would miss it, so the loop stops instead.
    expect(gaps(s.calls.map((x) => x.at))).toEqual([5_000, 5_000]);
  });

  it('makes exactly one request when the timeout is shorter than the interval', async () => {
    const { c, s } = poller(['PENDING']);

    const p = settled(
      c.bills.waitForTerminal(TXN_ID, {
        intervalMs: 5_000,
        maxIntervalMs: 5_000,
        timeoutMs: 100,
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayPollTimeoutError);
    expect(s.calls).toHaveLength(1);
  });
});

describe('poll cancellation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts mid-poll when the signal fires during a backoff nap', async () => {
    const ctl = new AbortController();
    const { c, s } = poller(['PROCESSING']);

    const p = c.bills.waitForTerminal(TXN_ID, { ...POLL, signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();

    await expect(p).rejects.toBeInstanceOf(BillPayAbortError);
    // It gave up inside the first nap, so only the opening read ever went out.
    expect(s.calls).toHaveLength(1);
  });

  it('refuses without a single request when the signal is already aborted', async () => {
    const { c, s } = poller(['SUCCESS']);

    const p = c.bills.waitForTerminal(TXN_ID, { ...POLL, signal: AbortSignal.abort() });

    await expect(p).rejects.toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(0);
  });

  it('reports an abort as ABORTED, distinct from a poll timeout', async () => {
    const ctl = new AbortController();
    const { c } = poller(['PROCESSING']);

    const p = c.bills.waitForTerminal(TXN_ID, { ...POLL, signal: ctl.signal });
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();

    const e = (await p.catch((x: unknown) => x)) as BillPayAbortError;
    expect(e.code).toBe('ABORTED');
    expect(e).not.toBeInstanceOf(BillPayPollTimeoutError);
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

  it('rejects a bad transactionId on pay before spending a request', async () => {
    const s = stubFetch([{ json: ok({ transactionId: TXN_ID, status: 'PROCESSING' }) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(
      c.bills.pay({ transactionId: 'not-hex', billId: 'b1', ref: 'r' }),
    ).rejects.toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a blank ref on getByRef, which would otherwise fetch the whole list', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    await expect(c.bills.getByRef({ ref: '' })).rejects.toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });

  it('reports a guard failure as ERR_VALIDATION, the code the API would have sent', async () => {
    const s = stubFetch([{ json: ok(txn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const e = (await c.bills.get('nope').catch((x: unknown) => x)) as BillPayValidationError;
    expect(e.code).toBe('ERR_VALIDATION');
  });
});
