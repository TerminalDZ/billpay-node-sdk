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
  type MultiBillPayParams,
  type Partner,
  type PayParams,
  type SeaalAccount,
  type SingleBillPayParams,
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

/**
 * Every `.ts` under `src/`, at any depth, as a path relative to `src/`.
 *
 * Recursive on purpose. A flat `readdirSync` filtered by `.endsWith('.ts')` silently
 * drops directory entries, so the day anything moves to `src/internal/` the guard below
 * stops reading it — and a plain one-line `node:` import there sails through a green
 * suite. Walking is the only version of "the whole module graph" that stays true.
 */
const sourceFiles = (dir: URL, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
      : entry.name.endsWith('.ts')
        ? [`${prefix}${entry.name}`]
        : [],
  );

describe('browser safety', () => {
  const src = new URL('../../src/', import.meta.url);

  it('imports nothing from node: anywhere in the module graph', () => {
    // A bare `node:` specifier is a bundler error long before it is a runtime one: the
    // Vue app that imports this package simply fails to build. `ref.ts` is the file that
    // wants one — a UUID — so it is the one most likely to regress, but the guarantee is
    // about the whole graph, which is why every source file is read.
    //
    // The match anchors on the specifier rather than on the `import` keyword. Anchoring
    // on the keyword means the pattern has to reach across whatever sits between the two,
    // and a named list long enough for Prettier to break over several lines puts a
    // newline there — so the one formatting the repo already uses for its longer imports
    // is the one form the guard would miss.
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThanOrEqual(7);

    const offenders = files.filter((f) =>
      /['"]node:[^'"]*['"]/.test(readFileSync(new URL(f, src), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('catches a node: import however it is written', () => {
    // The guard is the only thing standing between a Node builtin and a broken browser
    // bundle, and nothing else in the repo looks: eslint has no import restriction, and
    // tsconfig sets `types: ["node"]` so the compiler is perfectly happy. So the pattern
    // itself is worth a test — including the multi-line form Prettier produces once a
    // named list passes 100 columns.
    const nodeImport = /['"]node:[^'"]*['"]/;
    const forms = [
      `import { randomUUID } from 'node:crypto';`,
      `import type { Buffer } from 'node:buffer';`,
      `import 'node:crypto';`,
      `import crypto from 'node:crypto';`,
      `import * as crypto from 'node:crypto';`,
      `export { randomUUID } from 'node:crypto';`,
      `const { randomUUID } = await import('node:crypto');`,
      `import {\n  randomUUID,\n  createHash,\n} from 'node:crypto';`,
      `import type {\n  Buffer,\n} from 'node:buffer';`,
      `export {\n  randomUUID,\n} from 'node:crypto';`,
    ];

    for (const form of forms) expect(nodeImport.test(form)).toBe(true);
    // And it does not fire on prose that merely mentions one, which is how the comment
    // above and half of ref.ts's own documentation are written.
    expect(nodeImport.test('// never import node:crypto here')).toBe(false);
  });

  it('never calls require either, which a CJS build would satisfy and a browser would not', () => {
    const offenders = sourceFiles(src).filter((f) =>
      /require\s*\(\s*['"]/.test(readFileSync(new URL(f, src), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('reads files below src/, not just the ones beside index.ts', () => {
    // The floor above only catches files moving *out* of src/. A module added under a
    // new subdirectory leaves the count where it was, so the walk is what has to be
    // asserted — and it is asserted against the one subdirectory that exists: none.
    const files = sourceFiles(src);
    expect(files).toContain('index.ts');
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(sourceFiles(new URL('../../tests/', import.meta.url))).toContain('unit/helpers.ts');
  });
});

describe('packaging', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  it('points each condition at declarations of its own module format', () => {
    // A flat `{ types, import, require }` map hands the single ESM `.d.ts` to the
    // `require` path as well, and because the package is `type: module` TypeScript then
    // refuses to let a CommonJS file import it — `TS1479`, under `module: node16` — even
    // though `dist/index.cjs` is sitting right there and works. tsup already emits
    // `index.d.cts`; it just has to be reachable. Runtime resolution is unaffected, which
    // is exactly why nothing else would notice.
    expect((pkg.exports as Record<string, unknown>)['.']).toEqual({
      import: { types: './dist/index.d.ts', default: './dist/index.js' },
      require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
    });
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

describe('SEAAL takes a code_client and a code_contrat, both of them', () => {
  it('accepts the one documented shape', () => {
    const account: SeaalAccount = { seaal: { code_client: '471135', code_contrat: '446547' } };
    const widened: AccountIdentifier = account;

    expect(widened).toEqual({ seaal: { code_client: '471135', code_contrat: '446547' } });
  });

  it('sends both halves nested inside seaal, exactly as given', async () => {
    const { c, s } = discovering();
    await c.bills.discover({
      partner: 'SEAAL',
      account: { seaal: { code_client: '0A12b3', code_contrat: '0044654' } },
      ref: 'seaal-1',
    });

    // Both halves travel as strings and neither is normalised: `code_client` is
    // alphanumeric, so it was never a number, and `code_contrat` is a string of digits
    // whose leading zeros are part of the value. They are copied off the customer's
    // paper water bill, and what they typed is what the portal judges.
    expect(s.calls[0]!.body).toMatchObject({
      account: { seaal: { code_client: '0A12b3', code_contrat: '0044654' } },
    });
  });

  it('rejects a seaal object carrying only code_client at compile time', () => {
    // @ts-expect-error — the portal authenticates on the PAIR, so half of it is not an
    // account. The other half missing is "seaal.code_contrat must be 2 to 10 digits".
    const bad: SeaalAccount = { seaal: { code_client: '471135' } };
    expect(bad).toBeDefined();
  });

  it('rejects a seaal object carrying only code_contrat at compile time', () => {
    // @ts-expect-error — "seaal.code_client must be 2 to 6 alphanumeric characters".
    const bad: SeaalAccount = { seaal: { code_contrat: '446547' } };
    expect(bad).toBeDefined();
  });

  it('rejects a numeric code_contrat at compile time', () => {
    // @ts-expect-error — 2 to 10 digits as a string, not a quantity: leading zeros matter.
    const bad: SeaalAccount = { seaal: { code_client: '471135', code_contrat: 446547 } };
    expect(bad).toBeDefined();
  });

  it('rejects a third field inside seaal at compile time', () => {
    const bad: SeaalAccount = {
      // @ts-expect-error — the pair is the whole identifier; there is no third part to
      // it. The directive sits on the property rather than above the declaration because
      // that is the line TypeScript reports an excess nested key on.
      seaal: { code_client: '471135', code_contrat: '446547', code_agence: '16' },
    };
    expect(bad).toBeDefined();
  });

  it('rejects the flat codeClient echo as a request identifier at compile time', () => {
    // @ts-expect-error — `codeClient` is what comes *back*. Nothing flat goes out: SEAAL
    // has no single key that identifies an account, which is the whole reason the
    // request form is a nested pair rather than a shorthand like `reference`.
    const bad: AccountIdentifier = { codeClient: '471135' };
    expect(bad).toBeDefined();
  });

  it('echoes the identifier back flat, as codeClient rather than reference', async () => {
    // The same asymmetry as `aadl{}` → `codeloc`: the pair goes out nested and a single
    // flat key comes home. Worth pinning because `reference` is the key a reader expects
    // here — that one is ADE's, and SEAAL has never used it.
    //
    // The body below is the fully settled account: READY with an empty `bills`, which is
    // a result rather than a failure. The water bill is paid; there is nothing to pick.
    const s = stubFetch([
      {
        json: ok(
          txn({ status: 'READY', partner: 'SEAAL', account: { codeClient: '471135' }, bills: [] }),
        ),
      },
    ]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const t = await c.bills.get(TXN_ID);
    expect(t.account).toEqual({ codeClient: '471135' });
    expect(t.bills).toEqual([]);
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
      { seaal: { code_client: '471135', code_contrat: '446547' } },
    ];

    expect(accounts).toHaveLength(9);

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

  it('rejects a SEAAL pair combined with a flat reference at compile time', () => {
    // @ts-expect-error — `seaal` and `reference` are different slots, and one is the
    // limit. The pairing is worth its own case because `reference` is precisely the key
    // SEAAL was wrongly documented as using, so it is the one a caller reaches for.
    const bad: AccountIdentifier = {
      reference: '0123456789012345678901234',
      seaal: { code_client: '471135', code_contrat: '446547' },
    };
    expect(bad).toBeDefined();
  });

  it('rejects a SEAAL pair beside an AADL codeloc at compile time', () => {
    // @ts-expect-error — two nested forms, and only one slot may be filled.
    const bad: AccountIdentifier = {
      seaal: { code_client: '471135', code_contrat: '446547' },
      aadl: { codeloc: '1112223334' },
    };
    expect(bad).toBeDefined();
  });

  it('rejects a widened object carrying seaal alongside another identifier', () => {
    // The load-bearing one, and the reason it does not look like its neighbours.
    //
    // Every other negative here is a fresh object literal, so TypeScript's excess
    // property check refuses it whatever the union says underneath — which means they
    // all keep passing even if `seaal` were added to `AccountIdentifier` without being
    // added to `AccountKey`. A variable is not fresh: assigning one tests assignability
    // alone, and assignability is the only thing `Only<>` speaks to. Leave `'seaal'`
    // out of `AccountKey` and no member pins `seaal?: never`, two identifiers start
    // type-checking in every non-literal position, and this line is what notices.
    const twoIdentifiers = {
      reference: '0123456789012345678901234',
      seaal: { code_client: '471135', code_contrat: '446547' },
    };

    // @ts-expect-error — exactly one identifier is allowed, freshness or no freshness.
    const bad: AccountIdentifier = twoIdentifiers;
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

describe('pay names one bill or a list of them, never both and never neither', () => {
  it('accepts the single form', () => {
    const one: SingleBillPayParams = { transactionId: TXN_ID, billId: 'F059107046', ref: 'p' };
    const widened: PayParams = one;

    expect(widened).toEqual({ transactionId: TXN_ID, billId: 'F059107046', ref: 'p' });
  });

  it('accepts the array form', () => {
    const many: MultiBillPayParams = {
      transactionId: TXN_ID,
      billIds: ['F059107046', 'F059107047'],
      ref: 'p',
    };
    const widened: PayParams = many;

    expect(widened).toEqual({
      transactionId: TXN_ID,
      billIds: ['F059107046', 'F059107047'],
      ref: 'p',
    });
  });

  it('rejects both at compile time', () => {
    // The combination the API answers `400 ERR_VALIDATION` to — "Provide exactly one of
    // billId or billIds". A caller who migrates a picker to the array form and leaves
    // the old field behind writes exactly this.
    // @ts-expect-error — exactly one selection, never two.
    const bad: PayParams = {
      transactionId: TXN_ID,
      billId: 'F059107046',
      billIds: ['F059107046'],
      ref: 'p',
    };
    expect(bad).toBeDefined();
  });

  it('rejects neither at compile time', () => {
    // @ts-expect-error — zero selections is as invalid as two: a payment has to say what
    // it is paying.
    const bad: PayParams = { transactionId: TXN_ID, ref: 'p' };
    expect(bad).toBeDefined();
  });

  it('rejects a widened object carrying both, not just a fresh literal', () => {
    // The load-bearing one, for the same reason as its twin in the account union above.
    // Every other negative here is a fresh object literal, which excess property
    // checking refuses whatever the union says underneath — so they would all keep
    // passing if `billIds?: never` were dropped from `SingleBillPayParams`. A variable
    // is not fresh: assigning one tests assignability alone, which is the only thing
    // those `never`s speak to.
    const bothSelections = {
      transactionId: TXN_ID,
      billId: 'F059107046',
      billIds: ['F059107047'],
      ref: 'p',
    };

    // @ts-expect-error — exactly one selection, freshness or no freshness.
    const bad: PayParams = bothSelections;
    expect(bad).toBeDefined();
  });

  it('rejects a bare string in place of the array at compile time', () => {
    // @ts-expect-error — `billIds` is a list even when the customer picked one facture.
    const bad: PayParams = { transactionId: TXN_ID, billIds: 'F059107046', ref: 'p' };
    expect(bad).toBeDefined();
  });

  it('rejects an array in place of the single id at compile time', () => {
    // @ts-expect-error — `billId` is the one-bill form; a list goes in `billIds`.
    const bad: PayParams = { transactionId: TXN_ID, billId: ['F059107046'], ref: 'p' };
    expect(bad).toBeDefined();
  });

  it('still requires a ref on the array form', () => {
    // @ts-expect-error — `ref` is required on every payment, whichever selection it names.
    const bad: PayParams = { transactionId: TXN_ID, billIds: ['F059107046'] };
    expect(bad).toBeDefined();
  });

  it('keeps every existing single-bill call site compiling unchanged', async () => {
    // `PayParams` went from an interface to a union in 0.5.0. That is a source-level
    // change to a published type, so the shape partners already wrote has to keep
    // type-checking and keep reaching the wire untouched.
    const s = stubFetch([{ json: ok({ transactionId: TXN_ID, status: 'PROCESSING' }) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const params: PayParams = { transactionId: TXN_ID, billId: 'F059107046', ref: 'p' };
    await c.bills.pay(params);

    expect(s.calls[0]!.body).toEqual({
      transactionId: TXN_ID,
      billId: 'F059107046',
      ref: 'p',
    });
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
