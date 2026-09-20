/**
 * Recovering after a timeout, without ever resending a payment.
 *
 *   npm run build
 *   BILLPAY_API_KEY=<sandbox key> node --experimental-strip-types examples/recover-after-timeout.ts
 *
 * A second client with a 120 ms timeout is used to force `BillPayTimeoutError` on the two
 * POSTs. The recovery is the same one you would write in production:
 *
 * - discover timed out → `getByRef(discoveryRef)`; 404 means it never landed, resend with the same ref.
 * - pay timed out → read the transaction; `READY` means the pay never landed, anything else means it did.
 */

import {
  BillPayClient,
  BillPayNotFoundError,
  BillPayTimeoutError,
  isTerminal,
  newRef,
  payRefFor,
  type Transaction,
} from '@terminaldz/billpay-sdk';

const apiKey = process.env.BILLPAY_API_KEY;
if (!apiKey) {
  console.error('Set BILLPAY_API_KEY to a sandbox key.');
  process.exit(1);
}
const baseUrl = process.env.BILLPAY_BASE_URL;

const client = new BillPayClient({ apiKey, baseUrl });
const impatient = new BillPayClient({ apiKey, baseUrl, timeoutMs: 120 });

const account = { electronic_payment_key: '0123456789012345678901234' } as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: this example pays, and the key is not a sandbox key.');
  process.exit(1);
}

// 1. A discovery whose response is lost.
const discoveryRef = newRef('recover');
try {
  await impatient.bills.discover({ partner: 'ADE', account, ref: discoveryRef });
  console.log('discover answered in time');
} catch (e) {
  if (!(e instanceof BillPayTimeoutError)) throw e;
  console.log(`discover: ${e.code} — unknown whether it landed`);
}
await sleep(1_500);

// 2. Look it up by the discovery ref before doing anything else.
let transaction: Transaction;
try {
  transaction = await client.bills.getByRef({ ref: discoveryRef, partner: 'ADE' });
  console.log(`recovered: ${transaction.transactionId} is ${transaction.status}`);
} catch (e) {
  if (!(e instanceof BillPayNotFoundError)) throw e;
  console.log('not found by ref — it never landed; sending again with the same ref');
  const ack = await client.bills.discover({ partner: 'ADE', account, ref: discoveryRef });
  transaction = await client.bills.get(ack.transactionId);
}
const { transactionId } = transaction;

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (!discovered.bills?.length) {
  console.log('Nothing to pay.');
  process.exit(0);
}
const bill = discovered.bills[0]!;

// 3. A payment whose response is lost.
try {
  await impatient.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });
  console.log('pay answered in time');
} catch (e) {
  if (!(e instanceof BillPayTimeoutError)) throw e;
  console.log(`pay: ${e.code} — the money may or may not have moved`);
}
await sleep(1_500);

// 4. Read the transaction. Only a READY transaction has not been paid.
const after = await client.bills.get(transactionId);
if (after.status === 'READY') {
  console.log('still READY — the pay never landed; sending it once with a fresh ref');
  await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });
} else if (!isTerminal(after.status)) {
  console.log(`${after.status} — in flight; keep polling, do not resend`);
} else {
  console.log(`${after.status} — already settled`);
}

const settled = isTerminal(after.status)
  ? after
  : await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });
console.log(
  `final: ${settled.status}${settled.status === 'SUCCESS' ? ` — debited ${settled.total} DZD` : ''}`,
);
