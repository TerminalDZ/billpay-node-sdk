/**
 * AADL: discover a housing file, show the notice breakdown, pay it whole, download the avis.
 *
 *   npm run build
 *   BILLPAY_API_KEY=<sandbox key> node --experimental-strip-types examples/aadl-avis.ts
 *
 * AADL issues one aggregate notice per housing file; arrears are included and cannot be
 * paid separately. Sandbox `codeloc` values (BILLPAY_AADL_CODELOC):
 *   1112223334  payable notice, 5400.00 DZD, with breakdown (default)
 *   2223334445  12000.00 DZD, two unpaid periods folded in
 *   3334445556  nothing due — READY with an empty bills[]
 *   4445556667  409 BILL_ALREADY_PAID at discovery
 *
 * The avis download is not available in the sandbox; the call below shows how to handle
 * that as a 404 rather than an error.
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayNotFoundError,
  newRef,
  payRefFor,
  type BillBreakdown,
} from '@terminaldz/billpay-sdk';

const apiKey = process.env.BILLPAY_API_KEY;
if (!apiKey) {
  console.error('Set BILLPAY_API_KEY to a sandbox key.');
  process.exit(1);
}

const client = new BillPayClient({ apiKey, baseUrl: process.env.BILLPAY_BASE_URL });
const codeloc = process.env.BILLPAY_AADL_CODELOC ?? '1112223334';

if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: this example pays, and the key is not a sandbox key.');
  process.exit(1);
}

const partners = await client.partners();
if (partners['AADL']?.status !== 'ACTIVE') {
  console.log('AADL is unavailable right now.');
  process.exit(0);
}

const discoveryRef = newRef('aadl');
let transactionId: string;
try {
  const ack = await client.bills.discover({
    partner: 'AADL',
    account: { aadl: { codeloc } },
    ref: discoveryRef,
  });
  transactionId = ack.transactionId;
} catch (e) {
  if (e instanceof BillPayConflictError && e.code === 'BILL_ALREADY_PAID') {
    console.log(`codeloc ${codeloc}: already settled`);
    process.exit(0);
  }
  throw e;
}

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (!discovered.bills?.length) {
  console.log('No open notice on this file.');
  process.exit(0);
}

const notice = discovered.bills[0]!;
const dzd = (n: number): string => `${n.toFixed(2)} DZD`;

// Render only the fields AADL sent; a zero you invented reads like one the biller published.
const breakdownLines = (b: BillBreakdown = {}): string[] => {
  const lines: string[] = [];
  if (b.site !== undefined) lines.push(`site: ${b.site}`);
  if (b.totalRent !== undefined) lines.push(`rent: ${dzd(b.totalRent)}`);
  if (b.totalCharges !== undefined) lines.push(`charges: ${dzd(b.totalCharges)}`);
  if (b.totalPenalties !== undefined) lines.push(`penalties: ${dzd(b.totalPenalties)}`);
  if (b.unpaidPeriods !== undefined) lines.push(`unpaid periods: ${b.unpaidPeriods}`);
  if (b.dueDate !== undefined) lines.push(`due: ${b.dueDate}`);
  return lines;
};

console.log(
  `${notice.label ?? 'Avis de paiement AADL'}${notice.period ? ` — ${notice.period}` : ''}`,
);
console.log(`  total: ${dzd(notice.amount)} + ${dzd(notice.fee)} fee`);
for (const line of breakdownLines(notice.breakdown)) console.log(`  ${line}`);

await client.bills.pay({ transactionId, billId: notice.billId, ref: payRefFor(discoveryRef) });
const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });
console.log(
  settled.status === 'SUCCESS'
    ? `settled: SUCCESS — debited ${settled.total} DZD`
    : `settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`,
);

try {
  const avis = await client.bills.avis(transactionId);
  console.log(`avis: ${avis.filename} (${avis.contentType}, ${avis.bytes.byteLength} bytes)`);
} catch (e) {
  if (e instanceof BillPayNotFoundError)
    console.log('avis: not available (sandbox, or not an AADL transaction)');
  else throw e;
}
