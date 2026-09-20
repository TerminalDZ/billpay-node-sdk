/**
 * The whole flow: discover → pick a bill → pay → wait → download the receipt.
 *
 *   npm run build
 *   BILLPAY_API_KEY=<sandbox key> node --experimental-strip-types examples/pay-a-bill.ts
 *
 * Sandbox and production share one host; the key decides. This example refuses to run
 * with anything but a sandbox key.
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayError,
  BillPayNotFoundError,
  BillPayPollTimeoutError,
  newRef,
  payRefFor,
} from '@terminaldz/billpay-sdk';

const apiKey = process.env.BILLPAY_API_KEY;
if (!apiKey) {
  console.error('Set BILLPAY_API_KEY to a sandbox key.');
  process.exit(1);
}

const client = new BillPayClient({ apiKey, baseUrl: process.env.BILLPAY_BASE_URL });

if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: this example pays, and the key is not a sandbox key.');
  process.exit(1);
}

// Keep the discovery ref: it is the one handle on the transaction if a response is lost.
const discoveryRef = newRef('example');
const { transactionId } = await client.bills.discover({
  partner: 'ADE',
  account: { electronic_payment_key: '0123456789012345678901234' },
  ref: discoveryRef,
});
console.log(`discovery started: ${transactionId} (ref ${discoveryRef})`);

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (discovered.status !== 'READY') {
  console.log(`discovery ${discovered.status}: ${discovered.error?.code}`);
  process.exit(0);
}
if (!discovered.bills?.length) {
  console.log('Nothing to pay.');
  process.exit(0);
}

// Show amount and fee from the response; never recompute the fee.
const bill = discovered.bills[0]!;
console.log(`bill: ${bill.billId} — ${bill.amount} DZD + ${bill.fee} fee`);

try {
  // A payment needs its own ref; reusing the discovery ref is 403 DUPLICATED_REF.
  await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });

  // UNKNOWN is not terminal; waitForTerminal keeps polling through it.
  const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });

  if (settled.status !== 'SUCCESS') {
    // FAILED: nothing debited. REFUNDED: debited, then returned in full.
    console.log(`settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`);
    process.exit(0);
  }

  console.log(`settled: SUCCESS — debited ${settled.total} DZD, operation ${settled.operationId}`);

  try {
    const receipt = await client.bills.receipt(transactionId);
    console.log(
      `receipt: ${receipt.filename} (${receipt.contentType}, ${receipt.bytes.byteLength} bytes)`,
    );
  } catch (e) {
    if (e instanceof BillPayNotFoundError) console.log('receipt: not available');
    else throw e;
  }
} catch (e) {
  if (e instanceof BillPayPollTimeoutError) {
    // Still in progress (usually UNKNOWN). Do not refund, do not resend: hand the id to
    // a background job and keep polling.
    console.log(`not settled yet (last status ${e.lastStatus}) — queue ${e.transactionId}`);
  } else if (e instanceof BillPayConflictError) {
    // Never resend a POST. Read the existing transaction by its discovery ref.
    const existing = await client.bills.getByRef({ ref: discoveryRef, partner: 'ADE' });
    console.log(`conflict (${e.code}) — existing transaction is ${existing.status}`);
  } else if (e instanceof BillPayError) {
    console.error(`${e.code}: ${e.message} (requestId ${e.requestId})`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
