import { describe, expect, it, vi } from 'vitest';
import {
  BillPayAbortError,
  BillPayClient,
  BillPayNetworkError,
  BillPayNotFoundError,
  BillPayTimeoutError,
  type HookContext,
} from '../../src/index.js';
import { err, ok, stubFetch, TXN_ID, txn } from './helpers.js';

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

describe('transport', () => {
  it('sends the key as X-Access-Token and nothing else', async () => {
    const { c, s } = mk([{ json: ok({ account: {}, key: { type: 'SANDBOX' } }) }]);
    await c.validate();

    expect(s.calls[0]!.headers['X-Access-Token']).toBe('sk_test');
    expect(s.calls[0]!.url).toBe('http://api.test/v3/validate');
    // No key smuggled into the query string.
    expect(s.calls[0]!.url).not.toContain('sk_test');
  });

  it('unwraps data from the success envelope', async () => {
    const { c } = mk([{ json: ok({ account: { id: 'partner_a' }, key: { type: 'SANDBOX' } }) }]);
    const r = await c.validate();
    expect(r.key.type).toBe('SANDBOX');
  });

  it('reads list counts from meta, and data as a bare array', async () => {
    // Drift: openapi.yaml claims data: { transactions: [...] }. The code returns a
    // bare array with counts in meta.
    const { c } = mk([{ json: ok([txn()], { total: 7, limit: 20, offset: 0 }) }]);
    const r = await c.bills.list();

    expect(Array.isArray(r.transactions)).toBe(true);
    expect(r.total).toBe(7);
    expect(r.limit).toBe(20);
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
});

describe('retry policy', () => {
  it('retries a GET on 5xx up to `retries` extra attempts', async () => {
    const { c, s } = mk(
      [
        { status: 500, json: err('INTERNAL_ERROR') },
        { status: 500, json: err('INTERNAL_ERROR') },
        { json: ok({ account: {}, key: { type: 'SANDBOX' } }) },
      ],
      { retries: 2 },
    );
    await c.validate();
    expect(s.calls).toHaveLength(3);
  });

  it('gives up after exhausting GET retries', async () => {
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR') }], { retries: 1 });
    await expect(c.validate()).rejects.toThrow();
    expect(s.calls).toHaveLength(2);
  });

  it('retries a GET on a network error', async () => {
    const { c, s } = mk(
      [{ throws: new TypeError('fetch failed') }, { json: ok([], { total: 0 }) }],
      { retries: 2 },
    );
    await c.bills.list();
    expect(s.calls).toHaveLength(2);
  });

  it('surfaces a network error once retries are exhausted', async () => {
    const { c } = mk([{ throws: new TypeError('fetch failed') }], { retries: 0 });
    await expect(c.validate()).rejects.toBeInstanceOf(BillPayNetworkError);
  });

  it('NEVER retries discover, even on 5xx', async () => {
    // A blind POST retry either duplicates a transaction or trips DUPLICATED_REF,
    // and tells you nothing about the first attempt. getByRef is the recovery path.
    const { c, s } = mk([{ status: 500, json: err('INTERNAL_ERROR') }], { retries: 3 });

    await expect(
      c.bills.discover({ partner: 'ADE', account: { reference: 'x' }, ref: 'r1' }),
    ).rejects.toThrow();
    expect(s.calls).toHaveLength(1);
  });

  it('NEVER retries pay, even on a network error', async () => {
    const { c, s } = mk([{ throws: new TypeError('fetch failed') }], { retries: 3 });

    await expect(
      c.bills.pay({ transactionId: TXN_ID, billId: 'b1', ref: 'r2' }),
    ).rejects.toBeInstanceOf(BillPayNetworkError);
    expect(s.calls).toHaveLength(1);
  });

  it('does not retry a GET on 4xx', async () => {
    const { c, s } = mk([{ status: 404, json: err('NOT_FOUND') }], { retries: 3 });
    await expect(c.bills.get(TXN_ID)).rejects.toBeInstanceOf(BillPayNotFoundError);
    expect(s.calls).toHaveLength(1);
  });
});

describe('timeout and abort', () => {
  it('times out a hanging request', async () => {
    const { c } = mk([{ hang: true }], { timeoutMs: 40, retries: 0 });
    await expect(c.validate()).rejects.toBeInstanceOf(BillPayTimeoutError);
  });

  it('reports a caller abort as an abort, not a timeout', async () => {
    const ctl = new AbortController();
    const { c } = mk([{ hang: true }], { timeoutMs: 5000, retries: 0 });

    const p = c.validate(ctl.signal);
    setTimeout(() => ctl.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(BillPayAbortError);
  });

  it('refuses immediately when the signal is already aborted', async () => {
    const { c, s } = mk([{ json: ok({}) }]);
    await expect(c.validate(AbortSignal.abort())).rejects.toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('hooks', () => {
  it('reports method, path, status and requestId — never headers or the key', async () => {
    const seen: HookContext[] = [];
    const s = stubFetch([
      { json: ok({ account: {}, key: { type: 'SANDBOX' } }), headers: { 'x-request-id': 'req_abc' } },
    ]);
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
});

describe('client isolation', () => {
  it('keeps two clients with different keys independent', async () => {
    const a = stubFetch([{ json: ok({ key: { type: 'SANDBOX' } }) }]);
    const b = stubFetch([{ json: ok({ key: { type: 'PRODUCTION' } }) }]);

    const ca = new BillPayClient({ apiKey: 'key_a', baseUrl: 'http://a.test', fetch: a.fetch });
    const cb = new BillPayClient({ apiKey: 'key_b', baseUrl: 'http://b.test', fetch: b.fetch });

    await Promise.all([ca.validate(), cb.validate()]);

    expect(a.calls[0]!.headers['X-Access-Token']).toBe('key_a');
    expect(b.calls[0]!.headers['X-Access-Token']).toBe('key_b');
    expect(a.calls[0]!.url).toContain('a.test');
    expect(b.calls[0]!.url).toContain('b.test');
  });
});
