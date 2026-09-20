/**
 * SEAAL: discover a water account, list its unpaid quarters, pay them as one order.
 *
 *   npm run build
 *   BILLPAY_API_KEY=<sandbox key> node --experimental-strip-types examples/seaal-quarters.ts
 *
 * The identifier is the pair `{ code_client, code_contrat }`. A water account commonly
 * carries several unpaid quarterly bills; `billIds` settles the selection as one order
 * with one fee on the combined amount.
 *
 * Sandbox `code_client` values (BILLPAY_SEAAL_CODE_CLIENT; any 2–10 digit `code_contrat`):
 *   100001  five unpaid quarters (default)     100004  one bill, payment declined
 *   100002  one unpaid quarter                 100005  400 INVALID_ACCOUNT
 *   100003  nothing due — READY, empty bills[]
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayNotFoundError,
  BillPayValidationError,
  newRef,
  payRefFor,
} from '@terminaldz/billpay-sdk';

const apiKey = process.env.BILLPAY_API_KEY;
if (!apiKey) {
  console.error('Set BILLPAY_API_KEY to a sandbox key.');
  process.exit(1);
}

const client = new BillPayClient({ apiKey, baseUrl: process.env.BILLPAY_BASE_URL });
const codeClient = process.env.BILLPAY_SEAAL_CODE_CLIENT ?? '100001';
const codeContrat = process.env.BILLPAY_SEAAL_CODE_CONTRAT ?? '446563';

if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: this example pays, and the key is not a sandbox key.');
  process.exit(1);
}

const partners = await client.partners();
if (partners['SEAAL']?.status !== 'ACTIVE') {
  console.log('SEAAL is unavailable right now.');
  process.exit(0);
}

const discoveryRef = newRef('seaal');
let transactionId: string;
try {
  const ack = await client.bills.discover({
    partner: 'SEAAL',
    account: { seaal: { code_client: codeClient, code_contrat: codeContrat } },
    ref: discoveryRef,
  });
  transactionId = ack.transactionId;
} catch (e) {
  if (e instanceof BillPayConflictError && e.code === 'BILL_ALREADY_PAID') {
    console.log(`account ${codeClient}: already settled`);
    process.exit(0);
  }
  if (e instanceof BillPayValidationError && e.code === 'INVALID_ACCOUNT') {
    console.log(`account ${codeClient}: rejected by the portal`);
    process.exit(0);
  }
  throw e;
}

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (discovered.status !== 'READY') {
  console.log(`discovery ${discovered.status}: ${discovered.error?.code}`);
  process.exit(0);
}
if (!discovered.bills?.length) {
  console.log('Nothing outstanding on this account.');
  process.exit(0);
}

const dzd = (n: number): string => `${n.toFixed(2)} DZD`;
console.log(`${discovered.bills.length} unpaid bill(s):`);
for (const bill of discovered.bills) {
  console.log(
    `  ${bill.billId}${bill.period ? ` — ${bill.period}` : ''} — ${dzd(bill.amount)} + ${dzd(bill.fee)} fee`,
  );
}

// One order for the whole selection: one fee on the combined amount.
const billIds = discovered.bills.map((b) => b.billId);
await client.bills.pay({ transactionId, billIds, ref: payRefFor(discoveryRef) });

const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });
if (settled.status !== 'SUCCESS') {
  console.log(`settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`);
  process.exit(0);
}

console.log(
  `settled: SUCCESS — ${settled.selectedBills?.length ?? 1} bill(s), debited ${settled.total} DZD`,
);

try {
  const receipt = await client.bills.receipt(transactionId);
  console.log(
    `receipt: ${receipt.filename} (${receipt.contentType}, ${receipt.bytes.byteLength} bytes)`,
  );
} catch (e) {
  if (e instanceof BillPayNotFoundError) console.log('receipt: not available');
  else throw e;
}
