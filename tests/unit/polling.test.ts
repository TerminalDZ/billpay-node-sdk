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
  BillPayNotFoundError,
  BillPayPollTimeoutError,
  BillPayUnavailableError,
  BillPayValidationError,
  isTerminal,
  TERMINAL_STATUSES,
  type TransactionStatus,
} from '../../src/index.js';
import { err, ok, settled, stubFetch, TXN_ID, txn } from './helpers.js';

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

describe('a failed poll is not a failed transaction', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A poller whose reads are the given responses, with the transport's own retries off. */
  const flaky = (responses: Parameters<typeof stubFetch>[0]) => {
    const s = stubFetch(responses);
    return {
      c: new BillPayClient({
        apiKey: 'k',
        baseUrl: 'http://api.test',
        fetch: s.fetch,
        retries: 0,
      }),
      s,
    };
  };

  it('rides out a run of 503s and settles on the read that follows', async () => {
    // The whole point. `waitForTerminal` is only ever called after pay returned
    // PROCESSING, so a payment is in flight; ending the watch over a few seconds of
    // upstream noise leaves it moving with nobody looking at it, which is precisely what
    // the polling guide forbids.
    const { c, s } = flaky([
      { json: ok(txn({ status: 'PROCESSING' })) },
      { status: 503, json: err('SERVICE_UNAVAILABLE') },
      { status: 503, json: err('SERVICE_UNAVAILABLE') },
      { status: 503, json: err('SERVICE_UNAVAILABLE') },
      { json: ok(txn({ status: 'SUCCESS' })) },
    ]);

    const p = c.bills.waitForTerminal(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('SUCCESS');
    expect(s.calls).toHaveLength(5);
  });

  it('rides out a rate limit and a dropped socket alike', async () => {
    const { c } = flaky([
      { status: 429, json: err('RATE_LIMIT_EXCEEDED') },
      { throws: new TypeError('fetch failed') },
      { status: 500, json: err('INTERNAL_ERROR') },
      { json: ok(txn({ status: 'READY', bills: [] })) },
    ]);

    const p = c.bills.waitForReady(TXN_ID, POLL);
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect((await p).status).toBe('READY');
  });

  it('gives up as a poll timeout, not as the transport error, when the reads never recover', async () => {
    // A caller has one branch for "the foreground wait ran out, hand this to
    // reconciliation". Surfacing the transport error instead drops the transaction into
    // the generic error branch, which logs and moves on.
    const { c } = flaky([{ status: 503, json: err('SERVICE_UNAVAILABLE', 'upstream is down') }]);

    const p = settled(c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000);

    const e = (await p) as BillPayPollTimeoutError;
    expect(e).toBeInstanceOf(BillPayPollTimeoutError);
    expect(e.transactionId).toBe(TXN_ID);
    // Nothing was ever read, so there is no status to report — and the refusal that used
    // the budget up is kept as the cause rather than thrown away.
    expect(e.lastStatus).toBeUndefined();
    expect(e.cause).toBeInstanceOf(BillPayUnavailableError);
    expect(e.message).toContain('never read');
  });

  it('keeps the last status it did manage to read', async () => {
    const { c } = flaky([
      { json: ok(txn({ status: 'UNKNOWN' })) },
      { status: 503, json: err('SERVICE_UNAVAILABLE') },
    ]);

    const p = settled(c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 30_000 }));
    await vi.advanceTimersByTimeAsync(30_000);

    const e = (await p) as BillPayPollTimeoutError;
    expect(e).toBeInstanceOf(BillPayPollTimeoutError);
    expect(e.lastStatus).toBe('UNKNOWN');
  });

  it('still rethrows a refusal that polling cannot fix', async () => {
    // A 404 is not transient: the id is wrong, or the key is for the other environment.
    // Looping on it to the deadline would spend two minutes learning nothing.
    const { c, s } = flaky([{ status: 404, json: err('NOT_FOUND') }]);

    const p = settled(c.bills.waitForTerminal(TXN_ID, POLL));
    await vi.advanceTimersByTimeAsync(POLL.timeoutMs);

    expect(await p).toBeInstanceOf(BillPayNotFoundError);
    expect(s.calls).toHaveLength(1);
  });

  it('stops for a bad id before it can start', async () => {
    const { c, s } = flaky([{ json: ok(txn()) }]);

    expect(await settled(c.bills.waitForTerminal('nope', POLL))).toBeInstanceOf(
      BillPayValidationError,
    );
    expect(s.calls).toHaveLength(0);
  });
});

describe('the deadline covers the reads, not just the naps', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up on time even when a single read hangs past the whole budget', async () => {
    // Without a deadline signal reaching the request, one hanging read costs
    // `retries + 1` full request timeouts before the loop gets to look at the clock
    // again, and the handoff to reconciliation fires long after the request it belonged
    // to has gone.
    const s = stubFetch([{ hang: true }]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      timeoutMs: 600_000,
      retries: 2,
    });

    const p = settled(c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(10_000);

    const e = (await p) as BillPayPollTimeoutError;
    expect(e).toBeInstanceOf(BillPayPollTimeoutError);
    expect(e.lastStatus).toBeUndefined();
  });

  it('is not fooled into reporting a deadline as the caller changing their mind', async () => {
    // Both arrive at the request as the same aborted signal. A caller who catches
    // BillPayAbortError reconciles nothing, because an abort is their own decision.
    const s = stubFetch([{ hang: true }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const p = settled(c.bills.waitForReady(TXN_ID, { ...POLL, timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await p).not.toBeInstanceOf(BillPayAbortError);
    expect(await p).toBeInstanceOf(BillPayPollTimeoutError);
  });

  it('still reports a caller abort as an abort when both could apply', async () => {
    const ctl = new AbortController();
    const s = stubFetch([{ hang: true }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const p = settled(
      c.bills.waitForTerminal(TXN_ID, { ...POLL, timeoutMs: 5_000, signal: ctl.signal }),
    );
    await vi.advanceTimersByTimeAsync(100);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayAbortError);
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

/**
 * `onPoll` exists because a promise can only report where a transaction ended up, and a
 * screen needs to show where it has been. These tests hold it to that: every read is
 * reported, in order, including the last one — and an observer that throws must not be
 * able to abandon a wait with money behind it.
 */
describe('onPoll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports every status it reads, in order, including the settling one', async () => {
    const { c } = poller(['PENDING', 'READY']);
    const seen: TransactionStatus[] = [];

    const p = settled(
      c.bills.waitForReady(TXN_ID, { ...POLL, onPoll: (t) => seen.push(t.status) }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(seen).toEqual(['PENDING', 'READY']);
  });

  it('reports the UNKNOWN hold that the returned transaction no longer shows', async () => {
    // The whole point: after the fact, this refund is indistinguishable from an
    // immediate one. Only the observer knows it was held first.
    const { c } = poller(['PROCESSING', 'UNKNOWN', 'UNKNOWN', 'REFUNDED']);
    const seen: TransactionStatus[] = [];

    const p = settled(
      c.bills.waitForTerminal(TXN_ID, { ...POLL, onPoll: (t) => seen.push(t.status) }),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(seen).toEqual(['PROCESSING', 'UNKNOWN', 'UNKNOWN', 'REFUNDED']);
    await expect(p).resolves.toMatchObject({ status: 'REFUNDED' });
  });

  it('does not let a throwing observer abandon the wait', async () => {
    const { c } = poller(['PENDING', 'READY']);
    let calls = 0;

    const p = settled(
      c.bills.waitForReady(TXN_ID, {
        ...POLL,
        onPoll: () => {
          calls++;
          throw new Error('a component unmounted mid-payment');
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(p).resolves.toMatchObject({ status: 'READY' });
    expect(calls).toBe(2);
  });

  it('is optional, and its absence changes nothing', async () => {
    const { c, s } = poller(['PENDING', 'READY']);

    const p = settled(c.bills.waitForReady(TXN_ID, POLL));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(p).resolves.toMatchObject({ status: 'READY' });
    expect(s.calls).toHaveLength(2);
  });
});
