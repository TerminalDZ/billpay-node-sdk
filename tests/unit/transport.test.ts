/**
 * The transport: where a call goes, what it carries, when it is tried again, and how a
 * response is unwrapped.
 *
 * Two of these are regression tests for bugs that made the SDK unusable against the real
 * deployment — the host it talked to, and the path `partners()` used — so they assert
 * literal strings rather than "something sensible". A test that only checks the URL is
 * well-formed would have passed throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BillPayAbortError,
  BillPayClient,
  BillPayNetworkError,
  BillPayNotFoundError,
  BillPayRateLimitError,
  BillPayTimeoutError,
  BillPayValidationError,
  DEFAULT_BASE_URL,
  type HookContext,
} from '../../src/index.js';
import {
  err,
  ok,
  okBare,
  routerMiss,
  settled,
  stubFetch,
  TXN_ID,
  txn,
  VALIDATE_DATA,
} from './helpers.js';

const mk = (responses: Parameters<typeof stubFetch>[0], opts = {}) => {
  const s = stubFetch(responses);
  return {
    c: new BillPayClient({
      apiKey: 'sk_test',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      ...opts,
    }),
    s,
  };
};

/** Milliseconds between successive attempts, relative to the first. */
const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]!);

describe('base url and path construction', () => {
  it('defaults to the host that actually serves the API', async () => {
    // `billapi.oneclickdz.com` resolves and answers — with 401 INVALID_ACCESS_TOKEN for
    // every key, sandbox and production alike. Pointing at it is indistinguishable from
    // a bad key, which is why this asserts the literal host.
    expect(DEFAULT_BASE_URL).toBe('https://api.oneclickdz.com');

    const s = stubFetch([{ json: ok({ ADE: { status: 'ACTIVE' } }) }]);
    const c = new BillPayClient({ apiKey: 'sk_test', fetch: s.fetch });
    await c.partners();

    expect(s.calls[0]!.url).toBe('https://api.oneclickdz.com/v3/bills/partners');
  });

  it('asks for partners under /v3/bills, where they live', async () => {
    // `/v3/partners` is a 404. The partner map is part of the bills API, not the platform.
    const { c, s } = mk([{ json: ok({}) }]);
    await c.partners();

    expect(new URL(s.calls[0]!.url).pathname).toBe('/v3/bills/partners');
  });

  it('sends each call to its documented method and path', async () => {
    const paths: Array<[string, string, () => Promise<unknown>]> = [];
    const s = stubFetch([{ json: ok(txn({ status: 'READY' })) }]);
    const c = new BillPayClient({ apiKey: 'sk_test', baseUrl: 'http://api.test', fetch: s.fetch });

    paths.push(['GET', '/v3/validate', () => c.validate()]);
    paths.push(['GET', '/v3/bills/partners', () => c.partners()]);
    paths.push([
      'POST',
      '/v3/bills/discover',
      () =>
        c.bills.discover({
          partner: 'AADL',
          account: { aadl: { codeloc: '1112223334' } },
          ref: 'r',
        }),
    ]);
    paths.push([
      'POST',
      '/v3/bills/pay',
      () => c.bills.pay({ transactionId: TXN_ID, billId: 'b1', ref: 'r' }),
    ]);
    paths.push(['GET', '/v3/bills/transactions', () => c.bills.list()]);
    paths.push(['GET', '/v3/bills/transactions/by-ref', () => c.bills.getByRef({ ref: 'r' })]);
    paths.push(['GET', `/v3/bills/transactions/${TXN_ID}`, () => c.bills.get(TXN_ID)]);
    paths.push(['GET', `/v3/bills/transactions/${TXN_ID}/receipt`, () => c.bills.receipt(TXN_ID)]);
    paths.push(['GET', `/v3/bills/transactions/${TXN_ID}/avis`, () => c.bills.avis(TXN_ID)]);

    for (const [method, path, call] of paths) {
      await call().catch(() => undefined);
      const last = s.calls[s.calls.length - 1]!;
      expect([last.method, new URL(last.url).pathname]).toEqual([method, path]);
    }
  });

  it('normalises a base url given with a trailing slash', async () => {
    const s = stubFetch([{ json: ok(VALIDATE_DATA) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test///', fetch: s.fetch });
    await c.validate();

    expect(s.calls[0]!.url).toBe('http://api.test/v3/validate');
  });

  it('keeps a base url that carries a path prefix', async () => {
    // A partner behind their own gateway mounts the API somewhere of their choosing.
    const s = stubFetch([{ json: ok(VALIDATE_DATA) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://gw.test/billpay', fetch: s.fetch });
    await c.validate();

    expect(s.calls[0]!.url).toBe('http://gw.test/billpay/v3/validate');
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['undefined', undefined],
  ])('falls back to the default when baseUrl is %s', async (_label, baseUrl) => {
    // This is the `.env` case, not a hypothetical. `BILLPAY_BASE_URL=` is how a file says
    // "use the default", and it arrives here as the empty string — which `??` would take
    // literally, leaving every request to die on `new URL('')` deep in the transport.
    const s = stubFetch([{ json: ok(VALIDATE_DATA) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl, fetch: s.fetch });
    await c.validate();

    expect(s.calls[0]!.url).toBe(`${DEFAULT_BASE_URL}/v3/validate`);
  });

  it('rejects an unparseable base url at construction, not on the first call', () => {
    // A typo in the host is the caller's to fix, and the useful moment to say so is while
    // they are still looking at the line that configured it.
    const s = stubFetch([{ json: ok(VALIDATE_DATA) }]);

    expect(() => new BillPayClient({ apiKey: 'k', baseUrl: 'api.test', fetch: s.fetch })).toThrow(
      BillPayValidationError,
    );
    expect(() => new BillPayClient({ apiKey: 'k', baseUrl: 'api.test', fetch: s.fetch })).toThrow(
      /baseUrl/,
    );
    expect(s.calls).toHaveLength(0);
  });

  it('serialises list filters into the query string', async () => {
    const { c, s } = mk([{ json: ok([], { total: 0 }) }]);
    await c.bills.list({ status: 'SUCCESS', partner: 'ADE', limit: 5, offset: 10 });

    const u = new URL(s.calls[0]!.url);
    expect(u.searchParams.get('status')).toBe('SUCCESS');
    expect(u.searchParams.get('partner')).toBe('ADE');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('offset')).toBe('10');
  });

  it('omits undefined filters entirely', async () => {
    const { c, s } = mk([{ json: ok([], { total: 0 }) }]);
    await c.bills.list({ status: 'SUCCESS' });

    const u = new URL(s.calls[0]!.url);
    expect(u.searchParams.has('partner')).toBe(false);
    expect(u.searchParams.has('limit')).toBe(false);
  });

  it('keeps an accented partner name intact through the query string', async () => {
    const { c, s } = mk([{ json: ok([], { total: 0 }) }]);
    await c.bills.list({ partner: 'Algérie Télécom' });

    // The API compares the name character for character, so the accents have to survive
    // being escaped for the wire and unescaped again. `Algerie Telecom` is a 400.
    expect(new URL(s.calls[0]!.url).searchParams.get('partner')).toBe('Algérie Télécom');
  });

  it('narrows a by-ref lookup with the partner when one is given', async () => {
    const { c, s } = mk([{ json: ok(txn()) }]);
    await c.bills.getByRef({ ref: 'order-1', partner: 'AADL' });

    const u = new URL(s.calls[0]!.url);
    expect(u.searchParams.get('ref')).toBe('order-1');
    expect(u.searchParams.get('partner')).toBe('AADL');
  });
});

describe('request headers and body', () => {
  it('sends the key as X-Access-Token and nothing else', async () => {
    const { c, s } = mk([{ json: ok(VALIDATE_DATA) }]);
    await c.validate();

    expect(s.calls[0]!.headers['X-Access-Token']).toBe('sk_test');
    // No second copy of the credential: an `authorization` header is accepted by the
    // API but sending both doubles the places a log can leak it.
    expect(Object.keys(s.calls[0]!.headers).sort()).toEqual(['Accept', 'X-Access-Token']);
    // And nothing smuggled into the query string, where it would reach access logs.
    expect(s.calls[0]!.url).not.toContain('sk_test');
  });

  it('asks for JSON on an enveloped call and anything at all on a download', async () => {
    const { c, s } = mk([
      { json: ok(VALIDATE_DATA) },
      {
        bytes: new TextEncoder().encode('%PDF-1.4'),
        headers: { 'content-type': 'application/pdf' },
      },
    ]);

    await c.validate();
    await c.bills.avis(TXN_ID);

    expect(s.calls[0]!.headers['Accept']).toBe('application/json');
    expect(s.calls[1]!.headers['Accept']).toBe('*/*');
  });

  it('sets Content-Type only when there is a body to describe', async () => {
    const { c, s } = mk([
      { json: ok(txn()) },
      { json: ok({ transactionId: TXN_ID, ref: 'r', status: 'PENDING' }) },
    ]);

    await c.bills.get(TXN_ID);
    await c.bills.discover({ partner: 'ADE', account: { reference: 'x' }, ref: 'r' });

    expect(s.calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(s.calls[1]!.headers['Content-Type']).toBe('application/json');
  });

  it('posts a discovery as exactly partner, account and ref', async () => {
    const { c, s } = mk([{ json: ok({ transactionId: TXN_ID, ref: 'r', status: 'PENDING' }) }]);
    await c.bills.discover({
      partner: 'AADL',
      account: { aadl: { codeloc: '1112223334' } },
      ref: 'order-7',
    });

    expect(s.calls[0]!.body).toEqual({
      partner: 'AADL',
      account: { aadl: { codeloc: '1112223334' } },
      ref: 'order-7',
    });
  });

  it('posts a payment as exactly transactionId, billId and ref', async () => {
    const { c, s } = mk([{ json: ok({ transactionId: TXN_ID, status: 'PROCESSING' }) }]);
    await c.bills.pay({ transactionId: TXN_ID, billId: 'bill-1', ref: 'order-7-pay-abc' });

    expect(s.calls[0]!.body).toEqual({
      transactionId: TXN_ID,
      billId: 'bill-1',
      ref: 'order-7-pay-abc',
    });
  });
});

describe('envelope handling', () => {
  it('unwraps data from a success envelope', async () => {
    const { c } = mk([{ json: ok(VALIDATE_DATA) }]);
    expect((await c.validate()).apiKey.type).toBe('SANDBOX');
  });

  it('survives an envelope with no meta and no requestId', async () => {
    // `GET /v3/validate` sends `success` and `data` alone. Reading `meta.total`
    // unconditionally throws a TypeError on exactly this body and no other.
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    const r = await c.validate();

    expect(r.username).toBe('+213558601124');
    expect(r.apiKey.scope).toBe('READ-WRITE');
  });

  it('reads list counts from meta, and data as a bare array', async () => {
    // Drift: openapi.yaml claims data: { transactions: [...] }. The code returns a
    // bare array with counts in meta.
    const { c } = mk([{ json: ok([txn()], { total: 7, limit: 20, offset: 0 }) }]);
    const r = await c.bills.list();

    expect(Array.isArray(r.transactions)).toBe(true);
    expect(r.total).toBe(7);
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
  });

  it('derives list counts from the page when meta is missing', async () => {
    // A total derived this way is a floor, not the real count — but it beats a
    // TypeError, and a caller paging until a short page still terminates correctly.
    const { c } = mk([{ json: okBare([txn(), txn()]) }]);
    const r = await c.bills.list();

    expect(r.transactions).toHaveLength(2);
    expect(r.total).toBe(2);
    expect(r.limit).toBe(2);
    expect(r.offset).toBe(0);
  });

  it('fills in only the counts meta leaves out', async () => {
    const { c } = mk([{ json: ok([txn()], { total: 91 }) }]);
    const r = await c.bills.list();

    expect(r.total).toBe(91);
    expect(r.limit).toBe(1);
  });

  it('returns an empty page without inventing a total', async () => {
    const { c } = mk([{ json: okBare([]) }]);
    const r = await c.bills.list();

    expect(r.transactions).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('turns a router-level 404 into a typed error rather than a decoding complaint', async () => {
    // Fastify answers an unknown path with `{ message, error, statusCode }` and no
    // `success` field at all. "Not found" is what happened; "I could not read the body"
    // is not, and would send the caller looking in the wrong place.
    const path = `/v3/bills/transactions/${TXN_ID}`;
    const { c } = mk([{ status: 404, json: routerMiss(path) }], { retries: 0 });

    const e = (await settled(c.bills.get(TXN_ID))) as BillPayNotFoundError;
    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe(`Route GET:${path} not found`);
  });
});

describe('retry policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a GET on 5xx up to `retries` extra attempts', async () => {
    const { c, s } = mk(
      [
        { status: 500, json: err('INTERNAL_ERROR') },
        { status: 500, json: err('INTERNAL_ERROR') },
        { json: ok(VALIDATE_DATA) },
      ],
      { retries: 2 },
    );

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(3);
    // 300ms, then 600ms: enough to ride out a restart, short enough that a caller with
    // a 15s timeout still gets an answer.
    expect(gaps(s.calls.map((x) => x.at))).toEqual([300, 600]);
  });

  it('defaults to two extra attempts when retries is not configured', async () => {
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR') }]);

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(3);
  });

  it('gives up after exhausting GET retries and surfaces the last refusal', async () => {
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR', 'still broken') }], {
      retries: 1,
    });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await p) as Error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'still broken' });
    expect(s.calls).toHaveLength(2);
  });

  it('retries a GET on 429, which is the server asking us to slow down', async () => {
    const { c, s } = mk([{ status: 429, json: err('RATE_LIMIT_EXCEEDED') }, { json: ok([]) }], {
      retries: 2,
    });

    const p = settled(c.bills.list());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(2);
  });

  it('waits exactly as long as Retry-After asks before trying again', async () => {
    const { c, s } = mk(
      [
        { status: 429, json: err('RATE_LIMIT_EXCEEDED'), headers: { 'retry-after': '2' } },
        { json: ok([]) },
      ],
      { retries: 2 },
    );

    const p = settled(c.bills.list());
    await vi.advanceTimersByTimeAsync(1_999);
    // Coming back early is what got us rate-limited in the first place.
    expect(s.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(gaps(s.calls.map((x) => x.at))).toEqual([2_000]);
  });

  it('falls back to its own backoff when the server sends no Retry-After', async () => {
    const { c, s } = mk([{ status: 429, json: err('RATE_LIMIT_EXCEEDED') }, { json: ok([]) }], {
      retries: 1,
    });

    const p = settled(c.bills.list());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(gaps(s.calls.map((x) => x.at))).toEqual([300]);
  });

  it('surfaces the rate limit once the retries are spent', async () => {
    const { c } = mk([{ status: 429, json: err('RATE_LIMIT_EXCEEDED', 'Too many requests.') }], {
      retries: 1,
    });

    const p = settled(c.bills.list());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayRateLimitError);
  });

  it('retries a GET on a network error', async () => {
    const { c, s } = mk([{ throws: new TypeError('fetch failed') }, { json: ok([]) }], {
      retries: 2,
    });

    const p = settled(c.bills.list());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(2);
  });

  it('surfaces a network error once retries are exhausted', async () => {
    const { c } = mk([{ throws: new TypeError('fetch failed') }], { retries: 0 });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayNetworkError);
  });

  it('NEVER retries discover, even on 5xx', async () => {
    // A blind POST retry either duplicates a transaction or trips DUPLICATED_REF,
    // and tells you nothing about the first attempt. getByRef is the recovery path.
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR') }], { retries: 3 });

    const p = settled(c.bills.discover({ partner: 'ADE', account: { reference: 'x' }, ref: 'r1' }));
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(1);
  });

  it('NEVER retries pay, even on a network error', async () => {
    const { c, s } = mk([{ throws: new TypeError('fetch failed') }], { retries: 3 });

    const p = settled(c.bills.pay({ transactionId: TXN_ID, billId: 'b1', ref: 'r2' }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayNetworkError);
    expect(s.calls).toHaveLength(1);
  });

  it('NEVER retries pay on 429 either, however inviting Retry-After looks', async () => {
    const { c, s } = mk(
      [{ status: 429, json: err('RATE_LIMIT_EXCEEDED'), headers: { 'retry-after': '1' } }],
      { retries: 3 },
    );

    const p = settled(c.bills.pay({ transactionId: TXN_ID, billId: 'b1', ref: 'r3' }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayRateLimitError);
    expect(s.calls).toHaveLength(1);
  });

  it('does not retry a GET on 4xx', async () => {
    const { c, s } = mk([{ status: 404, json: err('NOT_FOUND') }], { retries: 3 });

    const p = settled(c.bills.get(TXN_ID));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayNotFoundError);
    expect(s.calls).toHaveLength(1);
  });

  it('does not retry a GET refused for a bad key, which will refuse again', async () => {
    // Twenty consecutive rejections lock the key out. Retrying spends three of them.
    const { c, s } = mk([{ status: 401, json: err('INVALID_ACCESS_TOKEN') }], { retries: 3 });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(1);
  });

  it('makes a single attempt when retries is zero', async () => {
    const { c, s } = mk([{ status: 503, json: err('SERVICE_UNAVAILABLE') }], { retries: 0 });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(s.calls).toHaveLength(1);
  });
});

describe('timeout and abort', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('times out a hanging request at exactly timeoutMs', async () => {
    const { c } = mk([{ hang: true }], { timeoutMs: 5_000, retries: 0 });
    let outcome: unknown;

    const p = c.validate().then(
      (r) => (outcome = r),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await p;

    expect(outcome).toBeInstanceOf(BillPayTimeoutError);
    expect((outcome as BillPayTimeoutError).code).toBe('TIMEOUT');
    expect((outcome as BillPayTimeoutError).message).toContain('5000ms');
  });

  it('applies the timeout per attempt, not to the call as a whole', async () => {
    const { c, s } = mk([{ hang: true }], { timeoutMs: 1_000, retries: 1 });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayTimeoutError);
    expect(s.calls).toHaveLength(2);
  });

  it('reports a caller abort as an abort, not a timeout', async () => {
    // They mean different things to a caller: a timeout is the API being slow, an
    // abort is their own code changing its mind.
    const ctl = new AbortController();
    const { c } = mk([{ hang: true }], { timeoutMs: 60_000, retries: 0 });

    const p = settled(c.validate(ctl.signal));
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();

    const e = (await p) as BillPayAbortError;
    expect(e).toBeInstanceOf(BillPayAbortError);
    expect(e).not.toBeInstanceOf(BillPayTimeoutError);
    expect(e.code).toBe('ABORTED');
  });

  it('refuses immediately when the signal is already aborted', async () => {
    const { c, s } = mk([{ json: ok(VALIDATE_DATA) }]);

    expect(await settled(c.validate(AbortSignal.abort()))).toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(0);
  });

  it('stops retrying when the caller aborts during a backoff wait', async () => {
    const ctl = new AbortController();
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR') }], { retries: 3 });

    const p = settled(c.validate(ctl.signal));
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(1);
  });
});

describe('hooks', () => {
  it('reports method, path, status and requestId — never headers or the key', async () => {
    const seen: HookContext[] = [];
    const s = stubFetch([{ json: ok(VALIDATE_DATA), headers: { 'x-request-id': 'req_abc' } }]);
    const c = new BillPayClient({
      apiKey: 'sk_secret',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      onRequest: (ctx) => seen.push(ctx),
      onResponse: (ctx) => seen.push(ctx),
    });

    await c.validate();

    expect(seen[0]).toMatchObject({ method: 'GET', path: '/v3/validate' });
    expect(seen[1]).toMatchObject({ status: 200, requestId: 'req_abc' });
    expect(typeof seen[1]!.durationMs).toBe('number');
    expect(JSON.stringify(seen)).not.toContain('sk_secret');
    expect(JSON.stringify(seen)).not.toContain('headers');
  });

  it('reports the path without the query string, so filters cannot leak into a log', async () => {
    const seen: HookContext[] = [];
    const s = stubFetch([{ json: ok([]) }]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      onRequest: (ctx) => seen.push(ctx),
    });

    await c.bills.list({ status: 'SUCCESS' });
    expect(seen[0]!.path).toBe('/v3/bills/transactions');
  });

  it('still fires onResponse when the request fails', async () => {
    const onResponse = vi.fn();
    const s = stubFetch([{ throws: new TypeError('fetch failed') }]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 0,
      onResponse,
    });

    await expect(c.validate()).rejects.toThrow();
    expect(onResponse).toHaveBeenCalledOnce();
  });

  it('fires once per attempt, so a retried GET is visible as three', async () => {
    vi.useFakeTimers();
    const onRequest = vi.fn();
    const s = stubFetch([{ status: 500, json: err('INTERNAL_ERROR') }]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 2,
      onRequest,
    });

    const p = settled(c.validate());
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    vi.useRealTimers();

    expect(onRequest).toHaveBeenCalledTimes(3);
  });
});

describe('client isolation', () => {
  it('keeps two clients with different keys independent', async () => {
    const a = stubFetch([{ json: ok(VALIDATE_DATA) }]);
    const b = stubFetch([
      { json: ok({ ...VALIDATE_DATA, apiKey: { ...VALIDATE_DATA.apiKey, type: 'PRODUCTION' } }) },
    ]);

    const ca = new BillPayClient({ apiKey: 'key_a', baseUrl: 'http://a.test', fetch: a.fetch });
    const cb = new BillPayClient({ apiKey: 'key_b', baseUrl: 'http://b.test', fetch: b.fetch });

    const [ra, rb] = await Promise.all([ca.validate(), cb.validate()]);

    expect(a.calls[0]!.headers['X-Access-Token']).toBe('key_a');
    expect(b.calls[0]!.headers['X-Access-Token']).toBe('key_b');
    expect(a.calls[0]!.url).toContain('a.test');
    expect(b.calls[0]!.url).toContain('b.test');
    // A sandbox client and a production one can share a process without either one
    // deciding for the other which environment it is in.
    expect(ra.apiKey.type).toBe('SANDBOX');
    expect(rb.apiKey.type).toBe('PRODUCTION');
  });
});
