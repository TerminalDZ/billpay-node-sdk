import { describe, expect, it } from 'vitest';
import {
  BillPayAuthError,
  BillPayClient,
  BillPayConflictError,
  BillPayError,
  BillPayInternalError,
  BillPayNotFoundError,
  BillPayUnavailableError,
  BillPayValidationError,
  type SyncErrorCode,
} from '../../src/index.js';
import { err, stubFetch } from './helpers.js';

/**
 * `retries: 0` throughout: these assert the code→class mapping, not the retry policy.
 * Leaving retries on would make every 5xx case sit through the backoff (and the 503
 * cases through `Retry-After: 5`) for no extra coverage. Retry has its own suite.
 */
const client = (responses: Parameters<typeof stubFetch>[0]) => {
  const s = stubFetch(responses);
  return {
    c: new BillPayClient({
      apiKey: 'sk_test',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 0,
    }),
    s,
  };
};

/** Every synchronous code, its HTTP status, and the class a caller branches on. */
const MATRIX: Array<[SyncErrorCode, number, new (...a: never[]) => BillPayError]> = [
  ['MISSING_ACCESS_TOKEN', 401, BillPayAuthError],
  ['INVALID_ACCESS_TOKEN', 401, BillPayAuthError],
  ['AUTH_UNAVAILABLE', 503, BillPayUnavailableError],
  ['DUPLICATED_REF', 403, BillPayConflictError],
  ['ERR_VALIDATION', 400, BillPayValidationError],
  ['INVALID_ACCOUNT', 400, BillPayValidationError],
  ['BILL_ALREADY_PAID', 409, BillPayConflictError],
  ['PAYMENT_IN_PROGRESS', 409, BillPayConflictError],
  ['NOT_FOUND', 404, BillPayNotFoundError],
  ['PAYLOAD_TOO_LARGE', 413, BillPayValidationError],
  ['PARTNER_UNAVAILABLE', 503, BillPayUnavailableError],
  ['SERVICE_UNAVAILABLE', 503, BillPayUnavailableError],
  ['INTERNAL_ERROR', 500, BillPayInternalError],
];

describe('error mapping', () => {
  it('covers all thirteen synchronous codes', () => {
    expect(MATRIX).toHaveLength(13);
  });

  for (const [code, status, Cls] of MATRIX) {
    it(`maps ${code} (${status}) to ${Cls.name}`, async () => {
      const { c } = client([{ status, json: err(code, `${code} happened`) }]);
      const e = await c.validate().catch((x: unknown) => x);

      expect(e).toBeInstanceOf(Cls);
      expect(e).toBeInstanceOf(BillPayError);
      expect((e as BillPayError).code).toBe(code);
      expect((e as BillPayError).httpStatus).toBe(status);
      expect((e as BillPayError).requestId).toBe('req_test000000000000000000');
    });
  }

  it('keeps an unknown code verbatim and falls back to the HTTP status', async () => {
    const { c } = client([{ status: 409, json: err('SOME_NEW_CODE') }]);
    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;

    expect(e).toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('SOME_NEW_CODE');
  });

  it('surfaces error.details when present', async () => {
    const { c } = client([
      { status: 400, json: err('ERR_VALIDATION', 'bad', ['ref is required']) },
    ]);
    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;
    expect(e.details).toEqual(['ref is required']);
  });

  it('surfaces Retry-After on 503', async () => {
    const { c } = client([
      { status: 503, json: err('AUTH_UNAVAILABLE'), headers: { 'retry-after': '5' } },
    ]);
    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e.retryAfter).toBe(5);
    expect(e.isRetryable).toBe(true);
  });

  it('treats AUTH_UNAVAILABLE as unavailability, not an auth failure', async () => {
    // The key is fine; the API could not verify it in time. Mistaking this for a bad
    // key sends partners rotating credentials that were never the problem.
    const { c } = client([{ status: 503, json: err('AUTH_UNAVAILABLE') }]);
    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e).not.toBeInstanceOf(BillPayAuthError);
  });

  it('marks 4xx as non-retryable and 5xx as retryable', async () => {
    const { c: c1 } = client([{ status: 400, json: err('ERR_VALIDATION') }]);
    const e1 = (await c1.validate().catch((x: unknown) => x)) as BillPayError;
    expect(e1.isRetryable).toBe(false);

    const { c: c2 } = client([{ status: 500, json: err('INTERNAL_ERROR') }]);
    const e2 = (await c2.validate().catch((x: unknown) => x)) as BillPayError;
    expect(e2.isRetryable).toBe(true);
  });

  it('never puts the API key in the message, properties or stack', async () => {
    const secret = 'sk_live_super_secret_key';
    const s = stubFetch([{ status: 401, json: err('INVALID_ACCESS_TOKEN') }]);
    const c = new BillPayClient({ apiKey: secret, baseUrl: 'http://api.test', fetch: s.fetch, retries: 0 });

    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;
    const dump = `${e.message}|${e.stack}|${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;

    expect(dump).not.toContain(secret);
  });

  it('rejects a blank apiKey at construction', () => {
    expect(() => new BillPayClient({ apiKey: '   ' })).toThrow(BillPayValidationError);
  });

  it('throws a typed error on a non-JSON body rather than a bare Error', async () => {
    const { c } = client([{ status: 200, bytes: new TextEncoder().encode('<html>nope') }]);
    const e = (await c.validate().catch((x: unknown) => x)) as BillPayError;

    expect(e).toBeInstanceOf(BillPayError);
    expect(e.code).toBe('INVALID_RESPONSE');
  });
});
