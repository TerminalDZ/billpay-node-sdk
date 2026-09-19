/**
 * How a refusal reaches the caller.
 *
 * Every case here goes through the public client rather than calling the error factories
 * directly, because what a partner actually branches on is the object that comes out of
 * `await`, not an internal mapping table.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BillPayAbortError,
  BillPayAuthError,
  BillPayClient,
  BillPayConflictError,
  BillPayError,
  BillPayInternalError,
  BillPayNotFoundError,
  BillPayRateLimitError,
  BillPayUnavailableError,
  BillPayValidationError,
  type KeyErrorCode,
  type SyncErrorCode,
} from '../../src/index.js';
import { err, ok, routerMiss, settled, stubFetch, TXN_ID, VALIDATE_DATA } from './helpers.js';

/**
 * `retries: 0` throughout: these assert the code→class mapping, not the retry policy.
 * Leaving retries on would make every 5xx and 429 case sit through the backoff for no
 * extra coverage. Retry has its own suite, on a fake clock.
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

/** Throw the given response at `validate()` and hand back whatever comes out. */
const thrown = async (response: Parameters<typeof stubFetch>[0][number]): Promise<BillPayError> => {
  const { c } = client([response]);
  return (await settled(c.validate())) as BillPayError;
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

/**
 * Codes from the shared key layer. They are not part of the Bill Payment contract but
 * reach every endpoint on the platform, so an integration that only handles the thirteen
 * above meets them as an unhandled `BillPayError` on its worst day.
 */
const KEY_MATRIX: Array<[KeyErrorCode, number, new (...a: never[]) => BillPayError]> = [
  ['ERR_AUTH', 401, BillPayAuthError],
  ['IP_BLOCKED', 403, BillPayAuthError],
  ['IP_NOT_ALLOWED', 403, BillPayAuthError],
  ['API_DISABLED', 403, BillPayAuthError],
  ['RATE_LIMIT_EXCEEDED', 429, BillPayRateLimitError],
];

describe('error mapping', () => {
  it('covers all thirteen synchronous codes', () => {
    expect(MATRIX).toHaveLength(13);
  });

  for (const [code, status, Cls] of MATRIX) {
    it(`maps ${code} (${status}) to ${Cls.name}`, async () => {
      const e = await thrown({ status, json: err(code, `${code} happened`) });

      expect(e).toBeInstanceOf(Cls);
      expect(e).toBeInstanceOf(BillPayError);
      expect(e.code).toBe(code);
      expect(e.httpStatus).toBe(status);
      expect(e.requestId).toBe('req_test000000000000000000');
    });
  }

  for (const [code, status, Cls] of KEY_MATRIX) {
    it(`maps the key-layer code ${code} (${status}) to ${Cls.name}`, async () => {
      const e = await thrown({ status, json: err(code) });

      expect(e).toBeInstanceOf(Cls);
      expect(e.code).toBe(code);
      expect(e.httpStatus).toBe(status);
    });
  }

  it('reads a 403 about the key as an auth failure, not a conflict', async () => {
    // Falling back on the status alone would file all three of these under
    // BillPayConflictError, next to DUPLICATED_REF — and send the reader looking for a
    // transaction that clashed rather than at the key's IP allowlist or its on/off switch.
    for (const code of ['IP_BLOCKED', 'IP_NOT_ALLOWED', 'API_DISABLED']) {
      const e = await thrown({ status: 403, json: err(code) });
      expect(e).toBeInstanceOf(BillPayAuthError);
      expect(e).not.toBeInstanceOf(BillPayConflictError);
    }
  });

  it('files the lockout code with the key, not with the conflicts', async () => {
    // IP_BLOCKED is what twenty consecutive bad attempts finally buy: the address stops
    // being served for about fifteen minutes. Sorting it by status alone lands it in
    // BillPayConflictError, whose documented advice is to look the existing transaction
    // up with getByRef — another request from an address that is answering nobody. The
    // useful reaction is to page somebody about the credential instead.
    const e = await thrown({
      status: 403,
      json: err('IP_BLOCKED', 'Your IP has been temporarily blocked'),
    });

    expect(e).toBeInstanceOf(BillPayAuthError);
    expect(e).not.toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('IP_BLOCKED');
    expect(e.isRetryable).toBe(false);
  });

  it('keeps an unknown code verbatim and falls back to the HTTP status', async () => {
    // The API may add codes without an SDK release; an unrecognised one is not itself
    // an error, so the class comes from the status and the code is passed through.
    const e = await thrown({ status: 409, json: err('SOME_NEW_CODE') });

    expect(e).toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('SOME_NEW_CODE');
  });

  it('keeps the API message verbatim rather than rewriting it', async () => {
    const message = 'Target bill not found in transaction history';
    const e = await thrown({ status: 404, json: err('NOT_FOUND', message) });

    expect(e.message).toBe(message);
  });

  it('surfaces error.details when present', async () => {
    const e = await thrown({
      status: 400,
      json: err('ERR_VALIDATION', 'bad', ['ref is required']),
    });

    expect(e.details).toEqual(['ref is required']);
  });

  it('names each error after its own class, for logs that print err.name', async () => {
    const e = await thrown({ status: 404, json: err('NOT_FOUND') });
    expect(e.name).toBe('BillPayNotFoundError');
  });

  it('is catchable as a plain Error', async () => {
    const e = await thrown({ status: 500, json: err('INTERNAL_ERROR') });
    expect(e).toBeInstanceOf(Error);
  });
});

describe('requestId', () => {
  it('prefers the id the envelope carries', async () => {
    const e = await thrown({
      status: 404,
      json: err('NOT_FOUND'),
      headers: { 'x-request-id': 'req_header' },
    });

    expect(e.requestId).toBe('req_test000000000000000000');
  });

  it('falls back to the response header when the envelope has none', async () => {
    const e = await thrown({
      status: 404,
      json: { success: false, error: { code: 'NOT_FOUND', message: 'nope' } },
      headers: { 'x-request-id': 'req_header' },
    });

    expect(e.requestId).toBe('req_header');
  });

  it('is null when the response carries no correlation id at all', async () => {
    // Verified live: the router-level 404 on `…/avis` sends no `x-request-id`. There is
    // nothing to quote to support, and pretending otherwise would be worse.
    const e = await thrown({ status: 404, json: routerMiss('/v3/bills/x') });
    expect(e.requestId).toBeNull();
  });
});

describe('retryability', () => {
  it('surfaces Retry-After when the server sends one', async () => {
    const e = await thrown({
      status: 503,
      json: err('AUTH_UNAVAILABLE'),
      headers: { 'retry-after': '5' },
    });

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e.retryAfter).toBe(5);
    expect(e.isRetryable).toBe(true);
  });

  it('leaves retryAfter undefined when the server sends none', async () => {
    // Only AUTH_UNAVAILABLE and a rate limit carry the header. An absent value means
    // "back off on your own schedule", never "come straight back".
    const e = await thrown({ status: 503, json: err('PARTNER_UNAVAILABLE') });

    expect(e.retryAfter).toBeUndefined();
    expect(e.isRetryable).toBe(true);
  });

  it('ignores a Retry-After it cannot read as seconds', async () => {
    const e = await thrown({
      status: 503,
      json: err('SERVICE_UNAVAILABLE'),
      headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    });

    expect(e.retryAfter).toBeUndefined();
  });

  it('treats AUTH_UNAVAILABLE as unavailability, not an auth failure', async () => {
    // The key is fine; the API could not verify it in time. Mistaking this for a bad
    // key sends partners rotating credentials that were never the problem.
    const e = await thrown({ status: 503, json: err('AUTH_UNAVAILABLE') });

    expect(e).toBeInstanceOf(BillPayUnavailableError);
    expect(e).not.toBeInstanceOf(BillPayAuthError);
  });

  it('marks SERVICE_UNAVAILABLE retryable even though the outcome is unknown', async () => {
    // The trap: it is transient, so retrying the *read* is right, but on a pay it means
    // the bill service did not answer in time — not that nothing happened.
    const e = await thrown({ status: 503, json: err('SERVICE_UNAVAILABLE') });
    expect(e.isRetryable).toBe(true);
  });

  it('marks a rate limit retryable', async () => {
    const e = await thrown({ status: 429, json: err('RATE_LIMIT_EXCEEDED') });

    expect(e).toBeInstanceOf(BillPayRateLimitError);
    expect(e.isRetryable).toBe(true);
  });

  it('marks 4xx as non-retryable and 5xx as retryable', async () => {
    expect((await thrown({ status: 400, json: err('ERR_VALIDATION') })).isRetryable).toBe(false);
    expect((await thrown({ status: 500, json: err('INTERNAL_ERROR') })).isRetryable).toBe(true);
  });

  it('never marks a conflict retryable, however inviting the name looks', async () => {
    // DUPLICATED_REF means there is already a transaction answering your question.
    // Resending is the one thing guaranteed not to help.
    expect((await thrown({ status: 403, json: err('DUPLICATED_REF') })).isRetryable).toBe(false);
  });

  it('never marks an abort retryable', async () => {
    const { c } = client([{ json: ok(VALIDATE_DATA) }]);
    const e = (await settled(c.validate(AbortSignal.abort()))) as BillPayAbortError;

    expect(e).toBeInstanceOf(BillPayAbortError);
    expect(e.isRetryable).toBe(false);
  });

  it('keeps the underlying failure as the cause of a network error', async () => {
    const cause = new TypeError('fetch failed');
    const { c } = client([{ throws: cause }]);
    const e = (await settled(c.validate())) as BillPayError;

    expect(e.cause).toBe(cause);
    expect(e.isRetryable).toBe(true);
  });
});

describe('responses that are not the house envelope', () => {
  it('maps a router-level 404 to NOT_FOUND and keeps the server sentence', async () => {
    // `{ message, error, statusCode }` with no `success` field. Today this is the
    // ordinary answer for a path that is documented but not yet deployed.
    const path = '/v3/bills/transactions/abc/avis';
    const e = await thrown({ status: 404, json: routerMiss(path) });

    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.httpStatus).toBe(404);
    expect(e.message).toBe(`Route GET:${path} not found`);
  });

  it('uses the canonical code for a status that has exactly one', async () => {
    const cases: Array<[number, string]> = [
      [413, 'PAYLOAD_TOO_LARGE'],
      [429, 'RATE_LIMIT_EXCEEDED'],
      [500, 'INTERNAL_ERROR'],
      [503, 'SERVICE_UNAVAILABLE'],
    ];

    for (const [status, code] of cases) {
      const e = await thrown({ status, json: { message: 'no envelope here', statusCode: status } });
      expect(e.code).toBe(code);
    }
  });

  it('invents HTTP_<status> where no single code fits, so it cannot be mistaken for one', async () => {
    // The API can never send `HTTP_502`, which is the point: a caller comparing `code`
    // can always tell a value the server chose from one the SDK inferred for it.
    const e = await thrown({ status: 502, json: { message: 'Bad gateway' } });

    expect(e.code).toBe('HTTP_502');
    expect(e).toBeInstanceOf(BillPayInternalError);
  });

  it('classifies an unenveloped 403 from the status alone', async () => {
    const e = await thrown({ status: 403, json: { message: 'Forbidden' } });

    expect(e).toBeInstanceOf(BillPayConflictError);
    expect(e.code).toBe('HTTP_403');
  });

  it('classifies an unenveloped 422 from a gateway as a validation failure', async () => {
    const e = await thrown({ status: 422, json: { message: 'Unprocessable' } });

    expect(e).toBeInstanceOf(BillPayValidationError);
    expect(e.code).toBe('HTTP_422');
  });

  it("falls back to the body's `error` string when there is no `message`", async () => {
    const e = await thrown({ status: 404, json: { error: 'Not Found', statusCode: 404 } });
    expect(e.message).toBe('Not Found');
  });

  it('says what it knows when the body explains nothing', async () => {
    const e = await thrown({ status: 404, json: {} });
    expect(e.message).toBe('The API answered HTTP 404.');
  });

  it('reports a failing status even when the body is not JSON at all', async () => {
    // A load balancer answering in HTML is still a refusal. "I could not read the body"
    // would send the reader looking at the SDK instead of at the status.
    const { c } = client([
      { status: 502, bytes: new TextEncoder().encode('<html>502 Bad Gateway</html>') },
    ]);
    const e = (await settled(c.validate())) as BillPayError;

    expect(e).toBeInstanceOf(BillPayInternalError);
    expect(e.httpStatus).toBe(502);
    expect(e.code).toBe('HTTP_502');
    expect(e.message).toContain('not JSON');
  });

  it('throws a typed error on a non-JSON body rather than a bare Error', async () => {
    const { c } = client([{ status: 200, bytes: new TextEncoder().encode('<html>nope') }]);
    const e = (await settled(c.validate())) as BillPayError;

    expect(e).toBeInstanceOf(BillPayError);
    expect(e.code).toBe('INVALID_RESPONSE');
  });

  it('refuses a 200 whose JSON is not an envelope it recognises', async () => {
    const { c } = client([{ status: 200, json: { username: 'bare', apiKey: {} } }]);
    const e = (await settled(c.validate())) as BillPayError;

    expect(e.code).toBe('INVALID_RESPONSE');
    expect(e.httpStatus).toBe(200);
  });
});

describe('secrets', () => {
  it('never puts the API key in the message, properties or stack', async () => {
    const secret = 'sk_live_super_secret_key';
    const s = stubFetch([{ status: 401, json: err('INVALID_ACCESS_TOKEN') }]);
    const c = new BillPayClient({
      apiKey: secret,
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 0,
    });

    const e = (await settled(c.validate())) as BillPayError;
    const dump = `${e.message}|${e.stack}|${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;

    expect(dump).not.toContain(secret);
  });
});

describe('construction', () => {
  it('rejects a blank apiKey at construction', () => {
    expect(() => new BillPayClient({ apiKey: '   ' })).toThrow(BillPayValidationError);
  });

  it('rejects a missing apiKey at construction', () => {
    expect(() => new BillPayClient({ apiKey: '' })).toThrow(BillPayValidationError);
  });

  it('explains itself when the runtime has no fetch and none was injected', async () => {
    // Node 16 and a few bundled workers. Saying so at construction beats a TypeError
    // from inside the transport on the first call.
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => new BillPayClient({ apiKey: 'k' })).toThrow(BillPayValidationError);
      expect(() => new BillPayClient({ apiKey: 'k' })).toThrow(/fetch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts an injected fetch on a runtime that has none of its own', async () => {
    const s = stubFetch([{ json: ok(VALIDATE_DATA) }]);
    vi.stubGlobal('fetch', undefined);
    try {
      const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });
      expect((await c.validate()).apiKey.type).toBe('SANDBOX');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('local guards', () => {
  it('raises ERR_VALIDATION locally, matching the code the API would have sent', async () => {
    const { c, s } = client([{ json: ok({}) }]);
    const e = (await settled(c.bills.receipt('not-a-txn-id'))) as BillPayError;

    expect(e).toBeInstanceOf(BillPayValidationError);
    expect(e.code).toBe('ERR_VALIDATION');
    // Caught before the request, so it costs nothing and cannot be rate-limited.
    expect(s.calls).toHaveLength(0);
    expect(e.httpStatus).toBeUndefined();
  });

  it('guards the avis download with the same id check as the receipt', async () => {
    const { c, s } = client([{ json: ok({}) }]);

    expect(await settled(c.bills.avis(TXN_ID.slice(0, 10)))).toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });
});
