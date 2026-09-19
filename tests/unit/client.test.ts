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
