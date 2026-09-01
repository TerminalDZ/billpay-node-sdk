/**
 * The whole flow: discover → pick a bill → pay → wait → download the receipt.
 *
 *   npm run build
 *   BILLPAY_API_KEY=sk_sbx_partner_a BILLPAY_BASE_URL=http://localhost:3100 \
 *     node --experimental-strip-types examples/pay-a-bill.ts
 *
 * Uses a sandbox key against the local stack: no portal is touched and no money moves.
 *
 * The import below is exactly what you write in your own project. Inside this repo it
 * resolves by self-reference through the package's own `exports` map, so the example
 * runs against the built artifact rather than a private path.
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayError,
  BillPayNotFoundError,
  newRef,
  payRefFor,
} from '@terminaldz/billpay-sdk';

const client = new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY ?? 'sk_sbx_partner_a',
  baseUrl: process.env.BILLPAY_BASE_URL ?? 'http://localhost:3100',
});

const { key } = await client.validate();
console.log(`key type: ${key.type}`);

// One ref for the discovery. Keep it: it is the only ref that resolves later.
const discoveryRef = newRef('example');
const { transactionId } = await client.bills.discover({
  partner: 'ADE',
  account: { reference: '0123456789012345678901234' },
  ref: discoveryRef,
});
console.log(`discovery started: ${transactionId} (ref ${discoveryRef})`);

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (!discovered.bills?.length) {
  console.log('Nothing payable — either nothing is due, or it is under the 200 DZD floor.');
  process.exit(0);
}

const bill = discovered.bills[0]!;
console.log(`bill: ${bill.billId} — ${bill.amount} DZD${bill.label ? ` (${bill.label})` : ''}`);

try {
  // The pay ref MUST differ from the discovery ref: that transaction is still live.
  await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });

  // UNKNOWN is not a failure and not terminal — waitForTerminal keeps polling through it.
  const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });
  console.log(`settled: ${settled.status}`);

  if (settled.status !== 'SUCCESS') {
    console.log(`reason: ${settled.error?.code} — ${settled.error?.message}`);
    process.exit(0);
  }

  // receiptUrl is set on every SUCCESS even when no bytes exist, so this can still 404.
  try {
    const receipt = await client.bills.receipt(transactionId);
    console.log(`receipt: ${receipt.filename} (${receipt.contentType}, ${receipt.bytes.byteLength} bytes)`);
  } catch (e) {
    if (e instanceof BillPayNotFoundError) console.log('receipt: not available for this transaction');
    else throw e;
  }
} catch (e) {
  if (e instanceof BillPayConflictError) {
    // Never blindly retry a POST. Recover with the DISCOVERY ref.
    const existing = await client.bills.getByRef({ ref: discoveryRef, partner: 'ADE' });
    console.log(`conflict (${e.code}) — existing transaction is ${existing.status}`);
  } else if (e instanceof BillPayError) {
    console.error(`${e.code}: ${e.message} (requestId ${e.requestId})`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
