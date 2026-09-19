/**
 * The two binary endpoints: `receipt()` and `avis()`.
 *
 * These are the only calls that do not return the house envelope, and the only ones that
 * used to hand a caller a JSON error body as a `Uint8Array` — which a caller would then
 * write to disk with a `.pdf` extension and discover weeks later. So most of what is
 * asserted here is the failure path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BillPayClient,
  BillPayInternalError,
  BillPayNotFoundError,
  BillPayValidationError,
  type Avis,
  type Receipt,
} from '../../src/index.js';
import { err, routerMiss, settled, stubFetch, TXN_ID } from './helpers.js';

const PDF = new TextEncoder().encode('%PDF-1.4\n%âãÏÓ\ntrailer\n%%EOF\n');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

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

describe('receipt', () => {
  it('downloads the bytes untouched', async () => {
    const { c, s } = mk([
      {
        bytes: PNG,
        headers: {
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="receipt_6a96b233.png"',
          'x-request-id': 'req_receipt',
        },
      },
    ]);

    const r = await c.bills.receipt(TXN_ID);

    expect(new URL(s.calls[0]!.url).pathname).toBe(`/v3/bills/transactions/${TXN_ID}/receipt`);
    expect(Array.from(r.bytes)).toEqual(Array.from(PNG));
    expect(r.contentType).toBe('image/png');
    expect(r.filename).toBe('receipt_6a96b233.png');
    expect(r.requestId).toBe('req_receipt');
  });

  it('names the file after the transaction when the server does not', async () => {
    const { c } = mk([{ bytes: PNG, headers: { 'content-type': 'image/png' } }]);
    const r = await c.bills.receipt(TXN_ID);

    expect(r.filename).toBe(`receipt-${TXN_ID}`);
  });

  it('calls an untyped body octet-stream rather than guessing at it', async () => {
    const { c } = mk([{ bytes: PNG }]);
    const r = await c.bills.receipt(TXN_ID);

    expect(r.contentType).toBe('application/octet-stream');
  });

  it('reports a missing correlation id as null rather than an empty string', async () => {
    const { c } = mk([{ bytes: PNG, headers: { 'content-type': 'image/png' } }]);
    expect((await c.bills.receipt(TXN_ID)).requestId).toBeNull();
  });

  it('throws when the manager holds no bytes, however confident receiptUrl looked', async () => {
    // `receiptUrl` is set on every SUCCESS, including the ones with no file behind them.
    // Its presence is not a promise, so this path is the normal one, not the exotic one.
    const { c } = mk([{ status: 404, json: err('NOT_FOUND', 'Receipt not available.') }]);
    const e = await settled(c.bills.receipt(TXN_ID));

    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect((e as BillPayNotFoundError).message).toBe('Receipt not available.');
  });

  it('never hands back a JSON error body as if it were the file', async () => {
    // The bug this replaces: a 404 envelope came back as `bytes`, and the caller wrote
    // 74 bytes of JSON to disk as a PDF.
    const { c } = mk([{ status: 404, json: err('NOT_FOUND') }]);
    const r = (await settled(c.bills.receipt(TXN_ID))) as Receipt;

    expect(r).toBeInstanceOf(BillPayNotFoundError);
    expect(r.bytes).toBeUndefined();
  });

  it('rejects a malformed transaction id before spending a request', async () => {
    const { c, s } = mk([{ bytes: PNG }]);

    expect(await settled(c.bills.receipt('6A96B233'))).toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('avis', () => {
  it('downloads AADL’s statement from the transaction that resolved it', async () => {
    const { c, s } = mk([
      {
        bytes: PDF,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="avis_${TXN_ID}.pdf"`,
          'cache-control': 'private, no-store',
          'x-request-id': 'req_avis',
        },
      },
    ]);

    const a: Avis = await c.bills.avis(TXN_ID);

    expect(s.calls[0]!.method).toBe('GET');
    expect(new URL(s.calls[0]!.url).pathname).toBe(`/v3/bills/transactions/${TXN_ID}/avis`);
    expect(s.calls[0]!.headers['X-Access-Token']).toBe('sk_test');
    // A download asks for anything rather than JSON, and carries no body to describe.
    expect(s.calls[0]!.headers['Accept']).toBe('*/*');
    expect(s.calls[0]!.headers['Content-Type']).toBeUndefined();
    expect(Array.from(a.bytes)).toEqual(Array.from(PDF));
    expect(a.contentType).toBe('application/pdf');
    expect(a.filename).toBe(`avis_${TXN_ID}.pdf`);
    expect(a.requestId).toBe('req_avis');
  });

  it('is addressed by transaction, never by housing file', async () => {
    // Deliberate, and the reason there is no `codeloc` parameter: AADL's own export page
    // answers with a PDF for any code it is handed, so proxying a caller-supplied one
    // would turn this into a way to enumerate other people's files.
    const { c, s } = mk([{ bytes: PDF, headers: { 'content-type': 'application/pdf' } }]);
    await c.bills.avis(TXN_ID);

    const u = new URL(s.calls[0]!.url);
    expect(u.search).toBe('');
    expect(u.pathname).toContain(TXN_ID);
  });

  it('assumes a PDF when the server sends no content type', async () => {
    const { c } = mk([{ bytes: PDF }]);
    const a = await c.bills.avis(TXN_ID);

    expect(a.contentType).toBe('application/pdf');
    expect(a.filename).toBe(`avis_${TXN_ID}.pdf`);
  });

  it('is the same shape as a receipt, so one helper can file either', () => {
    // Same shape, different documents: the receipt proves your payment went through,
    // the avis is AADL's own statement of what the housing file owes.
    const a: Avis = {
      bytes: PDF,
      contentType: 'application/pdf',
      filename: 'a.pdf',
      requestId: null,
    };
    const r: Receipt = a;

    expect(r.filename).toBe('a.pdf');
  });

  it('surfaces the router-level miss as a clean typed error, not a parse crash', async () => {
    // The live deployment does not route this yet, so today this *is* the avis path.
    // A caller should meet BillPayNotFoundError, exactly as they would for a receipt
    // that does not exist — and the day it ships, start getting a PDF instead.
    const path = `/v3/bills/transactions/${TXN_ID}/avis`;
    const { c } = mk([{ status: 404, json: routerMiss(path) }]);

    const e = (await settled(c.bills.avis(TXN_ID))) as BillPayNotFoundError;
    expect(e).toBeInstanceOf(BillPayNotFoundError);
    expect(e.code).toBe('NOT_FOUND');
    expect(e.httpStatus).toBe(404);
    expect(e.message).toBe(`Route GET:${path} not found`);
    // That response carries no `x-request-id`; there is nothing to quote to support.
    expect(e.requestId).toBeNull();
  });

  it('keeps the correlation id when the 404 does come from the application', async () => {
    const { c } = mk([{ status: 404, json: err('NOT_FOUND', 'Transaction not found') }]);
    const e = (await settled(c.bills.avis(TXN_ID))) as BillPayNotFoundError;

    expect(e.requestId).toBe('req_test000000000000000000');
  });

  it('reports a non-JSON refusal by its status rather than by the bytes', async () => {
    const { c } = mk([
      { status: 502, bytes: new TextEncoder().encode('<html>Bad Gateway</html>') },
    ]);

    const e = (await settled(c.bills.avis(TXN_ID))) as BillPayInternalError;
    expect(e).toBeInstanceOf(BillPayInternalError);
    expect(e.message).toBe('The API answered HTTP 502.');
    expect(e.code).toBe('HTTP_502');
  });

  it('rejects a malformed transaction id before spending a request', async () => {
    const { c, s } = mk([{ bytes: PDF }]);

    expect(await settled(c.bills.avis('avis-please'))).toBeInstanceOf(BillPayValidationError);
    expect(s.calls).toHaveLength(0);
  });
});

describe('filename parsing', () => {
  const download = async (disposition: string): Promise<string> => {
    const { c } = mk([
      {
        bytes: PDF,
        headers: { 'content-type': 'application/pdf', 'content-disposition': disposition },
      },
    ]);
    return (await c.bills.avis(TXN_ID)).filename;
  };

  it('reads a quoted filename', async () => {
    expect(await download('attachment; filename="avis_janvier.pdf"')).toBe('avis_janvier.pdf');
  });

  it('reads an unquoted filename', async () => {
    expect(await download('attachment; filename=avis.pdf')).toBe('avis.pdf');
  });

  it('stops at the next parameter rather than swallowing it', async () => {
    expect(await download('attachment; filename="avis.pdf"; creation-date="Mon"')).toBe('avis.pdf');
  });

  it('takes the extended filename* form without decoding its escapes', async () => {
    // Worth knowing before writing the result to disk: the percent-escapes are left as
    // they arrived rather than decoded into bytes that may not be safe in a path.
    expect(await download("attachment; filename*=UTF-8''avis%20ao%C3%BBt.pdf")).toBe(
      'avis%20ao%C3%BBt.pdf',
    );
  });

  it('falls back when the header names no file', async () => {
    expect(await download('attachment')).toBe(`avis_${TXN_ID}.pdf`);
  });
});

describe('downloads and the retry policy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries a download on 5xx, since a GET for bytes is as safe to repeat as any', async () => {
    const s = stubFetch([
      { status: 503, json: err('SERVICE_UNAVAILABLE') },
      { bytes: PDF, headers: { 'content-type': 'application/pdf' } },
    ]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 2,
    });

    const p = settled(c.bills.avis(TXN_ID));
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await p) as Avis).toMatchObject({ contentType: 'application/pdf' });
    expect(s.calls).toHaveLength(2);
  });

  it('does not retry a download that 404s', async () => {
    const s = stubFetch([{ status: 404, json: err('NOT_FOUND') }]);
    const c = new BillPayClient({
      apiKey: 'k',
      baseUrl: 'http://api.test',
      fetch: s.fetch,
      retries: 3,
    });

    const p = settled(c.bills.receipt(TXN_ID));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await p).toBeInstanceOf(BillPayNotFoundError);
    expect(s.calls).toHaveLength(1);
  });
});
