/**
 * Refs, the account-identifier union, and the promise that this package can be bundled
 * for a browser.
 *
 * Several of the tests below assert nothing at runtime — they are `@ts-expect-error`
 * lines, and they fail under `tsc --noEmit` if the compiler *stops* rejecting what they
 * describe. A type that quietly widens is exactly the kind of regression a green vitest
 * run will not notice, so the typecheck is part of this suite's job, not an extra.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BillPayClient,
  isValidRef,
  newRef,
  PARTNERS,
  payRefFor,
  REF_MAX_LENGTH,
  type AadlAccount,
  type AccountIdentifier,
  type DiscoverParams,
  type Partner,
} from '../../src/index.js';
import { aadlTxn, ok, stubFetch, TXN_ID, txn } from './helpers.js';

/** Canonical v4: the version nibble is `4` and the variant nibble is 8, 9, a or b. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const discovering = () => {
  const s = stubFetch([{ json: ok({ transactionId: TXN_ID, ref: 'r', status: 'PENDING' }) }]);
  return {
    c: new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch }),
    s,
  };
};

describe('browser safety', () => {
  it('imports nothing from node: anywhere in the module graph', () => {
    // A bare `node:` specifier is a bundler error long before it is a runtime one: the
    // Vue app that imports this package simply fails to build. `ref.ts` is the file that
    // wants one — a UUID — so it is the one most likely to regress, but the guarantee is
    // about the whole graph, which is why every source file is read.
    const src = new URL('../../src/', import.meta.url);
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(7);

    const offenders = files.filter((f) =>
      /(?:^|\s)(?:import|export)[^\n;]*?['"]node:/.test(readFileSync(new URL(f, src), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('never calls require either, which a CJS build would satisfy and a browser would not', () => {
    const src = new URL('../../src/', import.meta.url);
    const files = readdirSync(src).filter((f) => f.endsWith('.ts'));

    const offenders = files.filter((f) =>
      /require\s*\(\s*['"]/.test(readFileSync(new URL(f, src), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('uuid sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses crypto.randomUUID when the host offers it', () => {
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    vi.stubGlobal('crypto', { randomUUID: () => uuid });

    expect(newRef()).toBe(uuid);
  });

  it('falls back to getRandomValues when randomUUID is missing', () => {
    // The case that matters in practice: `randomUUID` is secure-context-only, so a Vue
    // dev server on plain `http://192.168.x.x` has `crypto` but not that method.
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        a.fill(0xff);
        return a;
      },
    });

    // Every byte is 0xff, so anything but the version and variant nibbles comes back
    // as `f` — which is what makes those two bits visible.
    expect(newRef()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('produces distinct refs from getRandomValues alone', () => {
    let n = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (a: Uint8Array) => {
        for (let i = 0; i < a.length; i++) a[i] = (n + i) % 256;
        n++;
        return a;
      },
    });

    const refs = new Set(Array.from({ length: 50 }, () => newRef()));
    expect(refs.size).toBe(50);
  });

  it('still generates a usable ref on a host with no Web Crypto at all', () => {
    // Last resort, and deliberately not a security hole: a ref is an idempotency key,
    // never a secret. A weak source degrades the collision odds — which the API reports
    // plainly as DUPLICATED_REF — rather than exposing anything.
    vi.stubGlobal('crypto', undefined);

    const refs = new Set(Array.from({ length: 500 }, () => newRef()));
    expect(refs.size).toBe(500);

    for (const r of refs) {
      expect(r).toMatch(UUID_V4);
      expect(isValidRef(r)).toBe(true);
      expect(r.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
    }
  });

  it('keeps the prefix and the limit with no Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);

    const r = newRef('z'.repeat(400));
    expect(r.length).toBe(REF_MAX_LENGTH);
    expect(r.startsWith('z')).toBe(true);
    expect(r.slice(-36)).toMatch(UUID_V4);
  });

  it('derives a pay ref with no Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);

    const d = newRef('order-1');
    expect(payRefFor(d)).not.toBe(payRefFor(d));
    expect(isValidRef(payRefFor(d))).toBe(true);
  });

  it('reads globalThis.crypto per call, so a host can install it late', () => {
    // Workers and some test runners populate `globalThis.crypto` after module load.
    // Caching the lookup at import time would pin whichever state got there first.
    vi.stubGlobal('crypto', undefined);
    const weak = newRef();

    vi.stubGlobal('crypto', { randomUUID: () => 'cafecafe-cafe-4afe-8afe-cafecafecafe' });
    expect(newRef()).toBe('cafecafe-cafe-4afe-8afe-cafecafecafe');
    expect(weak).not.toBe(newRef());
  });
});

describe('newRef', () => {
  it('generates a valid, unique ref with no prefix', () => {
    const a = newRef();
    const b = newRef();

    expect(a).not.toBe(b);
    expect(isValidRef(a)).toBe(true);
    expect(a).toMatch(UUID_V4);
    expect(a.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
  });

  it('namespaces by prefix', () => {
    const r = newRef('order-12345');

    expect(r.startsWith('order-12345-')).toBe(true);
    expect(isValidRef(r)).toBe(true);
  });

  it('truncates an over-long prefix to land exactly on the limit', () => {
    // Producing a ref the API would reject is worse than trimming the caller's prefix,
    // and trimming to *under* the limit would waste namespace for no reason.
    const r = newRef('x'.repeat(500));

    expect(r.length).toBe(REF_MAX_LENGTH);
    expect(isValidRef(r)).toBe(true);
  });

  it('keeps the uuid intact when truncating, so uniqueness survives', () => {
    const a = newRef('y'.repeat(500));
    const b = newRef('y'.repeat(500));

    expect(a).not.toBe(b);
    expect(a.slice(-36)).toMatch(UUID_V4);
  });

  it('stays within the limit even if the uuid source returns something absurd', () => {
    // A guard rather than a scenario: no real source produces a 99-character uuid. What
    // it pins is the rule — the limit wins over the prefix, always.
    vi.stubGlobal('crypto', { randomUUID: () => 'u'.repeat(99) });
    try {
      const r = newRef('order-1');
      expect(r.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
      expect(r).toBe('u'.repeat(99));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('collapses whitespace in a prefix', () => {
    expect(newRef('my order').startsWith('my-order-')).toBe(true);
  });

  it('falls back to a bare uuid for a blank prefix', () => {
    const r = newRef('   ');

    expect(isValidRef(r)).toBe(true);
    expect(r).toMatch(UUID_V4);
  });
});

describe('payRefFor', () => {
  it('produces a ref that differs from the discovery ref', () => {
    // Not because the API demands it — live testing shows it accepts the discovery ref
    // and answers 200 PROCESSING — but because two calls that share one ref are two
    // calls you cannot tell apart in your own logs.
    const d = newRef('order-1');
    const p = payRefFor(d);

    expect(p).not.toBe(d);
    expect(isValidRef(p)).toBe(true);
  });

  it('lands exactly on the limit for a maximum-length discovery ref', () => {
    const d = 'd'.repeat(REF_MAX_LENGTH);
    const p = payRefFor(d);

    expect(p.length).toBe(REF_MAX_LENGTH);
    expect(p).not.toBe(d);
  });

  it('is unique across calls for the same discovery ref', () => {
    const d = newRef();
    expect(payRefFor(d)).not.toBe(payRefFor(d));
  });

  it('keeps the discovery ref recognisable as a prefix', () => {
    expect(payRefFor('order-99').startsWith('order-99-pay-')).toBe(true);
  });

  it('survives an empty discovery ref without producing an unusable one', () => {
    expect(isValidRef(payRefFor(''))).toBe(true);
  });
});

describe('isValidRef', () => {
  it('rejects empty and whitespace-only refs', () => {
    expect(isValidRef('')).toBe(false);
    expect(isValidRef('   ')).toBe(false);
  });

  it('accepts exactly 100 characters and rejects 101', () => {
    expect(isValidRef('a'.repeat(100))).toBe(true);
    expect(isValidRef('a'.repeat(101))).toBe(false);
  });

  it('measures the trimmed ref, since that is what the API stores', () => {
    expect(isValidRef(`  ${'a'.repeat(100)}  `)).toBe(true);
  });
});

describe('partners', () => {
  it('lists all five, with the accents Algérie Télécom is compared by', () => {
    expect([...PARTNERS]).toEqual(['ADE', 'AADL', 'SONELGAZ', 'SEAAL', 'Algérie Télécom']);
  });

  it('rejects an unaccented partner name at compile time', () => {
    const p: DiscoverParams = {
      // @ts-expect-error — 'Algerie Telecom' without accents is not a partner value.
      partner: 'Algerie Telecom',
      account: { reference: 'a' },
      ref: 'r',
    };
    expect(p).toBeDefined();
  });

  it('accepts the accented Algérie Télécom value', () => {
    const p: DiscoverParams = {
      partner: 'Algérie Télécom',
      account: { phoneNumber: '023456789' },
      ref: 'r',
    };
    expect(p.partner).toBe('Algérie Télécom');
  });

  it('says nothing about which partners are available', () => {
    // Deliberate: PARTNERS is the set of names the API knows, not a claim about any of
    // them being switched on today. Availability lives in the live map and nowhere else.
    const names: Partner[] = [...PARTNERS];
    expect(names).not.toContain('ACTIVE');
  });
});

describe('AADL takes a codeloc and nothing else', () => {
  it('accepts the one documented shape', () => {
    const account: AadlAccount = { aadl: { codeloc: '1112223334' } };
    const widened: AccountIdentifier = account;

    expect(widened).toEqual({ aadl: { codeloc: '1112223334' } });
  });

  it('sends the codeloc nested inside aadl, exactly as given', async () => {
    const { c, s } = discovering();
    await c.bills.discover({
      partner: 'AADL',
      account: { aadl: { codeloc: '0011223344' } },
      ref: 'aadl-1',
    });

    // Leading zeros survive, and nothing is coerced to a number on the way out: the
    // housing file number is a string of digits, not a quantity.
    expect(s.calls[0]!.body).toMatchObject({
      account: { aadl: { codeloc: '0011223344' } },
    });
  });

  it('rejects billnum at compile time', () => {
    // Removed from the contract. The server's Joi layer strips unknown keys rather than
    // rejecting them, so sending it still answers 200 and changes nothing — leniency,
    // not a contract, and not something to let a caller build on.
    // @ts-expect-error — `aadl` carries `codeloc` alone.
    const bad: AadlAccount = { aadl: { codeloc: '1112223334', billnum: '77' } };
    expect(bad).toBeDefined();
  });

  it('rejects amount at compile time', () => {
    // @ts-expect-error — there is no second AADL method to carry an amount for.
    const bad: AadlAccount = { aadl: { codeloc: '1112223334', amount: 5400 } };
    expect(bad).toBeDefined();
  });

  it('rejects the retired billnum/amount pair at compile time', () => {
    const bad: DiscoverParams = {
      partner: 'AADL',
      // @ts-expect-error — the pair that used to be the second AADL method is gone.
      account: { aadl: { billnum: '77', amount: 5400 } },
      ref: 'r',
    };
    expect(bad).toBeDefined();
  });

  it('rejects an aadl object with no codeloc at compile time', () => {
    // @ts-expect-error — `codeloc` is always required.
    const bad: AadlAccount = { aadl: {} };
    expect(bad).toBeDefined();
  });

  it('rejects a numeric codeloc at compile time', () => {
    // @ts-expect-error — a string of 6 to 20 digits, not a number: leading zeros matter.
    const bad: AadlAccount = { aadl: { codeloc: 1112223334 } };
    expect(bad).toBeDefined();
  });

  it('rejects the retired aadlNumber shorthand at compile time', () => {
    // @ts-expect-error — AADL takes `aadl{ codeloc }`; the flat shorthand was removed
    // and the API answers 400 ERR_VALIDATION for it.
    const bad: AccountIdentifier = { aadlNumber: '1112223334' };
    expect(bad).toBeDefined();
  });

  it('rejects a flat account.codeloc at compile time', () => {
    // @ts-expect-error — `codeloc` travels inside `aadl`. Flat, the API answers 400
    // "account must contain exactly one identifier" — the response echoes it flat, but
    // the request may not send it that way.
    const bad: AccountIdentifier = { codeloc: '1112223334' };
    expect(bad).toBeDefined();
  });

  it('echoes the identifier back flat, as codeloc', async () => {
    // The asymmetry is the API's, not the SDK's: `aadl{}` goes out nested and comes
    // back flattened, alongside `reference`, `contractNumber` and `phoneNumber`.
    const s = stubFetch([{ json: ok(aadlTxn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const t = await c.bills.get(TXN_ID);
    expect(t.account).toEqual({ codeloc: '1112223334' });
  });

  it('returns one aggregate avis rather than a list of periods', async () => {
    // There is exactly one open avis per housing file, with every unpaid earlier period
    // folded into it. A multi-select bill picker here renders a list of one, forever.
    const s = stubFetch([{ json: ok(aadlTxn()) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const t = await c.bills.get(TXN_ID);
    expect(t.bills).toHaveLength(1);
    expect(t.bills?.[0]?.amount).toBe(5400);
  });
});

describe('account identifier union', () => {
  it('accepts each valid single-identifier form', async () => {
    const accounts: AccountIdentifier[] = [
      { reference: '0123456789012345678901234' },
      { contractNumber: '9876543210' },
      { phoneNumber: '023456789' },
      { electronic_payment_key: '0123456789012345678901234' },
      { phone_number: '023456789' },
      { sonelgaz: { invoice_number: '9876543210', amount_without_stamp: '15000', ebb_key: 'ABC' } },
      { ade: { sub_id: '000123456789', period: '07/2026', amount: '12000', pay_key: '1234567' } },
      { aadl: { codeloc: '1112223334' } },
    ];

    expect(accounts).toHaveLength(8);

    for (const account of accounts) {
      const { c, s } = discovering();
      await expect(
        c.bills.discover({ partner: 'ADE', account, ref: newRef() }),
      ).resolves.toBeDefined();
      // Forwarded untouched — the SDK does not normalise an identifier, so what the
      // customer typed is what the partner judges.
      expect((s.calls[0]!.body as { account: unknown }).account).toEqual(account);
    }
  });

  it('rejects two flat identifiers at compile time', () => {
    // @ts-expect-error — exactly one identifier is allowed, never two.
    const bad: AccountIdentifier = { reference: 'a', contractNumber: 'b' };
    expect(bad).toBeDefined();
  });

  it('rejects a nested form combined with a flat one at compile time', () => {
    // @ts-expect-error — `sonelgaz` and `reference` are mutually exclusive.
    const bad: AccountIdentifier = {
      reference: 'a',
      sonelgaz: { invoice_number: '1', amount_without_stamp: '2', ebb_key: '3' },
    };
    expect(bad).toBeDefined();
  });

  it('rejects two nested forms at compile time', () => {
    // @ts-expect-error — `ade` and `aadl` are different slots, and only one may be filled.
    const bad: AccountIdentifier = {
      ade: { sub_id: '000123456789', period: '07/2026', amount: '1', pay_key: '1234567' },
      aadl: { codeloc: '1112223334' },
    };
    expect(bad).toBeDefined();
  });

  it('rejects an AADL identifier paired with a landline at compile time', () => {
    // @ts-expect-error — one slot, whichever two the caller happens to have to hand.
    const bad: AccountIdentifier = { aadl: { codeloc: '1112223334' }, phoneNumber: '023456789' };
    expect(bad).toBeDefined();
  });

  it('rejects the snake_case and camelCase phone forms together at compile time', () => {
    // @ts-expect-error — they are the same slot spelled two ways, not two slots.
    const bad: AccountIdentifier = { phoneNumber: '023456789', phone_number: '023456789' };
    expect(bad).toBeDefined();
  });

  it('rejects an empty account at compile time', () => {
    // @ts-expect-error — zero identifiers is as invalid as two.
    const bad: AccountIdentifier = {};
    expect(bad).toBeDefined();
  });

  it('rejects an identifier the API has never heard of at compile time', () => {
    // @ts-expect-error — the slots are a closed set; a new one needs an SDK release.
    const bad: AccountIdentifier = { meterNumber: '1234' };
    expect(bad).toBeDefined();
  });

  it('rejects an incomplete nested form at compile time', () => {
    // @ts-expect-error — all three SONELGAZ invoice fields are required.
    const bad: AccountIdentifier = { sonelgaz: { invoice_number: '9876543210' } };
    expect(bad).toBeDefined();
  });
});

describe('bill breakdown', () => {
  const read = async (bills: unknown[]) => {
    const s = stubFetch([
      {
        json: ok(
          txn({
            status: 'READY',
            partner: 'AADL',
            account: { codeloc: '2223334445' },
            bills,
          }),
        ),
      },
    ]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });
    return c.bills.get(TXN_ID);
  };

  it('surfaces the partner-supplied components of an aggregate total', async () => {
    const t = await read([
      {
        billId: 'b1',
        amount: 12000,
        fee: 50,
        period: 'Juillet 2026',
        breakdown: {
          totalRent: 10000,
          totalCharges: 800,
          totalPenalties: 1200,
          unpaidPeriods: 2,
          site: 'Cite Sandbox B',
        },
      },
    ]);

    const b = t.bills?.[0]?.breakdown;
    expect(b?.totalRent).toBe(10000);
    expect(b?.totalCharges).toBe(800);
    expect(b?.totalPenalties).toBe(1200);
    // Two periods are folded into the one payable total — hence no paying a subset.
    expect(b?.unpaidPeriods).toBe(2);
    expect(b?.site).toBe('Cite Sandbox B');
  });

  it('leaves breakdown undefined when the partner publishes none', async () => {
    const t = await read([{ billId: 'b1', amount: 443.39, fee: 25 }]);
    expect(t.bills?.[0]?.breakdown).toBeUndefined();
  });

  it('leaves a field the partner omitted undefined rather than defaulting it to zero', async () => {
    // A `0` the SDK invented is indistinguishable from a `0` the biller published, and
    // the tenant reads both as "nothing owed under this heading".
    const t = await read([
      { billId: 'b1', amount: 5400, fee: 0, breakdown: { totalRent: 5000, site: 'Cite A' } },
    ]);

    const b = t.bills?.[0]?.breakdown;
    expect(b?.totalRent).toBe(5000);
    expect(b?.totalCharges).toBeUndefined();
    expect(b?.totalPenalties).toBeUndefined();
    expect(b?.unpaidPeriods).toBeUndefined();
  });

  it('keeps fee separate from amount, which sandbox zeroes and production will not', async () => {
    const t = await read([{ billId: 'b1', amount: 443.39, fee: 0 }]);

    expect(t.bills?.[0]?.amount).toBe(443.39);
    expect(t.bills?.[0]?.fee).toBe(0);
  });
});
