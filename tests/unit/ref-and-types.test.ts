import { describe, expect, it } from 'vitest';
import {
  BillPayClient,
  isValidRef,
  newRef,
  payRefFor,
  REF_MAX_LENGTH,
  type AccountIdentifier,
  type DiscoverParams,
} from '../../src/index.js';
import { ok, stubFetch, TXN_ID, txn } from './helpers.js';

describe('newRef', () => {
  it('generates a valid, unique ref with no prefix', () => {
    const a = newRef();
    const b = newRef();

    expect(a).not.toBe(b);
    expect(isValidRef(a)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
  });

  it('namespaces by prefix', () => {
    const r = newRef('order-12345');
    expect(r.startsWith('order-12345-')).toBe(true);
    expect(isValidRef(r)).toBe(true);
  });

  it('truncates an over-long prefix rather than exceeding the limit', () => {
    // Producing a ref the API would reject is worse than trimming the caller's prefix.
    const r = newRef('x'.repeat(500));
    expect(r.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
    expect(isValidRef(r)).toBe(true);
  });

  it('keeps the uuid intact when truncating, so uniqueness survives', () => {
    const a = newRef('y'.repeat(500));
    const b = newRef('y'.repeat(500));
    expect(a).not.toBe(b);
  });

  it('collapses whitespace in a prefix', () => {
    expect(newRef('my order').startsWith('my-order-')).toBe(true);
  });

  it('falls back to a bare uuid for a blank prefix', () => {
    expect(isValidRef(newRef('   '))).toBe(true);
  });
});

describe('payRefFor', () => {
  it('produces a ref that differs from the discovery ref', () => {
    // The discovery transaction is still live when you pay it, so its ref is taken.
    const d = newRef('order-1');
    const p = payRefFor(d);

    expect(p).not.toBe(d);
    expect(isValidRef(p)).toBe(true);
  });

  it('stays within the limit even for a maximum-length discovery ref', () => {
    const d = 'd'.repeat(REF_MAX_LENGTH);
    const p = payRefFor(d);

    expect(p.length).toBeLessThanOrEqual(REF_MAX_LENGTH);
    expect(p).not.toBe(d);
  });

  it('is unique across calls for the same discovery ref', () => {
    const d = newRef();
    expect(payRefFor(d)).not.toBe(payRefFor(d));
  });

  it('keeps the discovery ref recognisable as a prefix', () => {
    const p = payRefFor('order-99');
    expect(p.startsWith('order-99-pay-')).toBe(true);
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
});

describe('account identifier union', () => {
  it('accepts each valid single-identifier form', async () => {
    const s = stubFetch([{ json: ok({ transactionId: 'x', ref: 'r', status: 'PENDING' }) }]);
    const c = new BillPayClient({ apiKey: 'k', baseUrl: 'http://api.test', fetch: s.fetch });

    const accounts: AccountIdentifier[] = [
      { reference: '0123456789012345678901234' },
      { contractNumber: '9876543210' },
      { phoneNumber: '023456789' },
      { electronic_payment_key: '0123456789012345678901234' },
      { phone_number: '023456789' },
      { sonelgaz: { invoice_number: '9876543210', amount_without_stamp: '15000', ebb_key: 'ABC' } },
      { ade: { sub_id: '000123456789', period: '07/2026', amount: '12000', pay_key: '1234567' } },
      { aadl: { codeloc: '1112223334' } },
      { aadl: { codeloc: '1112223334', billnum: '778899', amount: '5400.00' } },
    ];

    for (const account of accounts) {
      await expect(
        c.bills.discover({ partner: 'ADE', account, ref: newRef() }),
      ).resolves.toBeDefined();
    }
  });

  it('rejects two identifiers at compile time', () => {
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

  it('rejects the retired aadlNumber shorthand at compile time', () => {
    // @ts-expect-error — AADL takes `aadl{ codeloc }`; the flat shorthand was removed
    // and the API now answers 400 "account.aadlNumber is not allowed".
    const bad: AccountIdentifier = { aadlNumber: '1112223334' };
    expect(bad).toBeDefined();
  });

  it('rejects an empty account at compile time', () => {
    // @ts-expect-error — zero identifiers is as invalid as two.
    const bad: AccountIdentifier = {};
    expect(bad).toBeDefined();
  });

  it('rejects an unknown partner at compile time', () => {
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
});
