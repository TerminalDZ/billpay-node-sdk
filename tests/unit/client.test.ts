/**
 * `validate()`, `environment()` and `partners()` — the three calls a caller makes before
 * they make any others.
 *
 * `validate` has the only response in the API with no `meta`, and the only one whose
 * shape the old SDK got wrong in a way no test could catch: it modelled a `data.account`
 * object that has never existed on the wire. So these tests assert the real payload field
 * by field rather than probing one property and calling it parsed.
 */

import { describe, expect, it } from 'vitest';
import {
  BillPayAbortError,
  BillPayAuthError,
  BillPayClient,
  BillsResource,
  environmentOf,
  type ApiEnvironment,
  type PartnersMap,
  type ValidateResult,
} from '../../src/index.js';
import { err, ok, okBare, settled, stubFetch, VALIDATE_DATA } from './helpers.js';

const mk = (responses: Parameters<typeof stubFetch>[0], opts = {}) => {
  const s = stubFetch(responses);
  return {
    c: new BillPayClient({
      apiKey: 'sk_test',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 0,
      ...opts,
    }),
    s,
  };
};

describe('validate', () => {
  it('parses the real payload, field for field', async () => {
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    const r: ValidateResult = await c.validate();

    expect(r.username).toBe('+213558601124');
    expect(r.apiKey.key).toBe('sk_test');
    expect(r.apiKey.isEnabled).toBe(true);
    expect(r.apiKey.type).toBe('SANDBOX');
    expect(r.apiKey.allowedips).toEqual([]);
    expect(r.apiKey.scope).toBe('READ-WRITE');
  });

  it('puts the environment at apiKey.type, one level below the key string', async () => {
    // The response carries both an `apiKey.key` *string* and an `apiKey.type`, and the
    // two are easy to confuse. The old SDK read `data.key.type` off an object that has
    // never been sent, and reported `undefined` for every key in both environments.
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    const r = await c.validate();

    expect(typeof r.apiKey.key).toBe('string');
    expect(r.apiKey.type).toBe('SANDBOX');
  });

  it('survives the absence of meta, which this response alone omits', async () => {
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    await expect(c.validate()).resolves.toBeDefined();
  });

  it('reads an IP allowlist back when the key has one', async () => {
    const { c } = mk([
      {
        json: okBare({
          ...VALIDATE_DATA,
          apiKey: { ...VALIDATE_DATA.apiKey, allowedips: ['41.100.0.1', '41.100.0.2'] },
        }),
      },
    ]);

    // An empty array means "usable from anywhere"; a populated one is the whitelist, and
    // calling from outside it is IP_NOT_ALLOWED rather than a bad key.
    expect((await c.validate()).apiKey.allowedips).toEqual(['41.100.0.1', '41.100.0.2']);
  });

  it('reports a disabled key as disabled rather than refusing the call', async () => {
    const { c } = mk([
      { json: okBare({ ...VALIDATE_DATA, apiKey: { ...VALIDATE_DATA.apiKey, isEnabled: false } }) },
    ]);

    expect((await c.validate()).apiKey.isEnabled).toBe(false);
  });

  it('surfaces a refused key as an auth error', async () => {
    const { c } = mk([{ status: 401, json: err('INVALID_ACCESS_TOKEN', 'Attempts left: 19/20.') }]);
    const e = await settled(c.validate());

    expect(e).toBeInstanceOf(BillPayAuthError);
  });

  it('honours a caller abort', async () => {
    const { c, s } = mk([{ json: okBare(VALIDATE_DATA) }]);

    expect(await settled(c.validate(AbortSignal.abort()))).toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('environment', () => {
  it('reads the environment off a single validate call', async () => {
    const { c, s } = mk([{ json: okBare(VALIDATE_DATA) }]);
    const env: ApiEnvironment = await c.environment();

    expect(env).toBe('SANDBOX');
    expect(s.calls).toHaveLength(1);
    expect(new URL(s.calls[0]!.url).pathname).toBe('/v3/validate');
  });

  it('reports PRODUCTION for a production key', async () => {
    // The only trustworthy answer to "am I about to move real money?". Both environments
    // share one base URL, so the URL says nothing and only the key does.
    const { c } = mk([
      {
        json: okBare({
          ...VALIDATE_DATA,
          apiKey: { ...VALIDATE_DATA.apiKey, type: 'PRODUCTION' },
        }),
      },
    ]);

    expect(await c.environment()).toBe('PRODUCTION');
  });

  it('agrees with environmentOf applied to the same result', async () => {
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    const result = await c.validate();

    expect(environmentOf(result)).toBe('SANDBOX');
    expect(environmentOf(result)).toBe(result.apiKey.type);
  });

  it('forwards an abort rather than swallowing it in the extra hop', async () => {
    const { c } = mk([{ json: okBare(VALIDATE_DATA) }]);
    expect(await settled(c.environment(AbortSignal.abort()))).toBeInstanceOf(BillPayAbortError);
  });
});

describe('partners', () => {
  it('returns the live map exactly as the server sent it', async () => {
    const map = {
      ADE: { status: 'ACTIVE' },
      AADL: { status: 'ACTIVE' },
      SONELGAZ: { status: 'ACTIVE' },
      SEAAL: { status: 'UNAVAILABLE' },
      'Algérie Télécom': { status: 'ACTIVE' },
    };
    const { c } = mk([{ json: ok(map) }]);

    // Verbatim, including the unavailable one: filtering here would hide the reason a
    // partner is missing from the picker, and the SDK has no business having an opinion
    // about which billers are switched on today.
    expect(await c.partners()).toEqual(map);
  });

  it('passes through a partner name the SDK has never heard of', async () => {
    // Availability and the roster both change without an SDK release, which is why
    // PartnersMap is keyed by `string` rather than by the Partner union.
    const { c } = mk([{ json: ok({ NEWBILLER: { status: 'ACTIVE' } }) }]);
    const map: PartnersMap = await c.partners();

    expect(map['NEWBILLER']?.status).toBe('ACTIVE');
  });

  it('reports an unavailable partner as unavailable, and not as an error', async () => {
    const { c } = mk([{ json: ok({ SEAAL: { status: 'UNAVAILABLE' } }) }]);
    const map = await c.partners();

    expect(map['SEAAL']?.status).toBe('UNAVAILABLE');
  });

  it('returns an empty map without inventing a roster to fill it', async () => {
    const { c } = mk([{ json: ok({}) }]);
    expect(await c.partners()).toEqual({});
  });

  it('honours a caller abort', async () => {
    const { c, s } = mk([{ json: ok({}) }]);

    expect(await settled(c.partners(AbortSignal.abort()))).toBeInstanceOf(BillPayAbortError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('client surface', () => {
  it('exposes the bills resource', () => {
    const { c } = mk([{ json: ok({}) }]);
    expect(c.bills).toBeInstanceOf(BillsResource);
  });
});

/**
 * The default `fetch` — the one nobody passes, and therefore the one every browser app
 * uses.
 *
 * The transport calls it as a method on its own config object. Node's `fetch` is an
 * ordinary function and does not care what `this` is, so this whole class of bug is
 * invisible to a suite that only ever runs in Node — which is how an unbound
 * `globalThis.fetch` shipped and turned every call from a page into
 * `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`, surfacing as a
 * `BillPayNetworkError` with nothing in it to suggest the cause.
 *
 * So the browser's contract is installed here instead: a `fetch` that refuses to run
 * detached from its global. Nothing else in the suite can catch this.
 */
describe('the default fetch', () => {
  it('survives being called detached from globalThis, as a browser requires', async () => {
    const realFetch = globalThis.fetch;
    const calls: string[] = [];

    globalThis.fetch = function thisSensitiveFetch(this: unknown, url: string): Promise<Response> {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      calls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(okBare(VALIDATE_DATA)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    } as unknown as typeof globalThis.fetch;

    try {
      const c = new BillPayClient({ apiKey: 'sk_test', baseUrl: 'http://api.test', retries: 0 });
      const result = await c.validate();

      expect(result.apiKey.type).toBe('SANDBOX');
      expect(calls).toEqual(['http://api.test/v3/validate']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('still refuses to construct when there is no fetch to bind', () => {
    const realFetch = globalThis.fetch;
    // @ts-expect-error — modelling a runtime older than Node 18, which has no fetch.
    delete globalThis.fetch;

    try {
      expect(() => new BillPayClient({ apiKey: 'sk_test' })).toThrow(/No fetch implementation/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
