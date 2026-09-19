/**
 * AADL, end to end: look a housing file up by its codeloc, read the avis, pay it whole,
 * and ask for AADL's own PDF.
 *
 *   npm run build
 *   BILLPAY_API_KEY=08fa18ec-f6d4-4f44-905f-de9acbc96f21 \
 *     node --experimental-strip-types examples/aadl-avis.ts
 *
 * AADL is the partner that does not fit the shape of the others. There is one identifier
 * and one aggregate total — no invoice object, no list of periods, no bill to choose —
 * and it is the only biller that publishes an *avis de paiement*, which is a different
 * document from the receipt. Everything below is built around those two facts.
 *
 * Set BILLPAY_AADL_CODELOC to walk the other sandbox scenarios; the values are listed
 * next to the constant.
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayNotFoundError,
  newRef,
  payRefFor,
  type BillBreakdown,
} from '@terminaldz/billpay-sdk';

const client = new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY ?? '08fa18ec-f6d4-4f44-905f-de9acbc96f21',
  baseUrl: process.env.BILLPAY_BASE_URL,
});

/**
 * The housing file number: digits only, 6 to 20 of them. The sandbox reads it as a
 * scenario selector, so each value below is a different shape of answer:
 *
 *   1112223334  a payable avis, 5400.00 DZD, with a full breakdown   (the default)
 *   2223334445  the same thing at 12000.00 DZD, two unpaid periods folded in
 *   3334445556  nothing due — READY with an empty bills[]
 *   4445556667  409 BILL_ALREADY_PAID, raised by the discovery itself
 */
const codeloc = process.env.BILLPAY_AADL_CODELOC ?? '1112223334';

// One field, and it is the only one that decides whether this run can charge anybody.
if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: that key is not a sandbox key, and this example pays.');
  process.exit(1);
}

// Ask, rather than assume. Availability changes in both environments without an SDK
// release, this map is the only honest record of it, and a biller that has been switched
// off answers 503 PARTNER_UNAVAILABLE to every identifier — which is a miserable thing to
// find out after a customer has typed theirs in. Build the partner picker from this call.
const partners = await client.partners();
console.log(`AADL: ${partners['AADL']?.status ?? 'not listed'}`);
if (partners['AADL']?.status !== 'ACTIVE') {
  console.log('AADL is not taking payments right now — hide it in your UI rather than fail later.');
  process.exit(0);
}

const discoveryRef = newRef('aadl');
let transactionId: string;

try {
  // The identifier is exactly this and nothing else: codeloc, nested inside `aadl`. A
  // flat `account.codeloc` is 400 ERR_VALIDATION ("account must contain exactly one
  // identifier"), and the billnum/amount pair the SDK used to accept has been removed
  // from the contract — writing it is now a compile error rather than a 400 you meet in
  // front of a customer.
  const ack = await client.bills.discover({
    partner: 'AADL',
    account: { aadl: { codeloc } },
    ref: discoveryRef,
  });
  transactionId = ack.transactionId;
  console.log(`discovery started: ${transactionId} (ref ${discoveryRef})`);
} catch (e) {
  if (e instanceof BillPayConflictError && e.code === 'BILL_ALREADY_PAID') {
    // AADL can answer this before a transaction exists: the file has nothing open for the
    // period, so there is no avis to show and nothing to pay. It is an answer, not a
    // failure — retrying it with a fresh ref changes nothing except your rate limit.
    console.log(`codeloc ${codeloc}: already settled — ${e.message}`);
    process.exit(0);
  }
  throw e;
}

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });

// The identifier comes back flattened: `{ aadl: { codeloc } }` goes out, a bare
// `{ codeloc }` comes home. Every partner echoes its own single key this way.
console.log(`file: ${discovered.account.codeloc ?? codeloc}`);

if (!discovered.bills?.length) {
  console.log('No avis is open on this file — nothing to pay and nothing to download.');
  process.exit(0);
}

// **AADL bills one aggregate total, never a list.** A housing file has exactly one open
// avis at a time, with every unpaid earlier period folded into it — breakdown.unpaidPeriods
// says how many — and AADL publishes nothing behind that total that could be settled
// separately. So there is no bill to pick here and no picker to build: the multi-select
// screen SONELGAZ genuinely needs would render a list of one, forever, and teach the
// tenant that they could pay a part of what they owe. Show the total; pay it whole.
const avisBill = discovered.bills[0]!;

const dzd = (n: number): string => `${n.toFixed(2)} DZD`;

/**
 * Render only what AADL actually sent.
 *
 * Every field of the breakdown is optional, and a zero you invented reads exactly like a
 * zero the biller published — "penalties: 0.00 DZD" is a promise, and it is not yours to
 * make. So each line appears if and only if its value arrived.
 */
const breakdownLines = (b: BillBreakdown = {}): string[] => {
  const lines: string[] = [];
  if (b.site !== undefined) lines.push(`site: ${b.site}`);
  if (b.totalRent !== undefined) lines.push(`rent: ${dzd(b.totalRent)}`);
  if (b.totalCharges !== undefined) lines.push(`charges: ${dzd(b.totalCharges)}`);
  if (b.totalPenalties !== undefined) lines.push(`penalties: ${dzd(b.totalPenalties)}`);
  if (b.unpaidPeriods !== undefined) lines.push(`periods folded in: ${b.unpaidPeriods}`);
  if (b.dueDate !== undefined) lines.push(`due: ${b.dueDate}`);
  return lines;
};

console.log(
  `avis: ${avisBill.label ?? 'Avis de paiement AADL'}` +
    `${avisBill.period ? ` — ${avisBill.period}` : ''}`,
);
console.log(`  total: ${dzd(avisBill.amount)} + ${dzd(avisBill.fee)} fee`);

const lines = breakdownLines(avisBill.breakdown);
if (lines.length) for (const line of lines) console.log(`  ${line}`);
else console.log('  (AADL published no breakdown for this file)');

await client.bills.pay({ transactionId, billId: avisBill.billId, ref: payRefFor(discoveryRef) });
const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });

if (settled.status === 'SUCCESS') {
  console.log(`settled: SUCCESS — debited ${settled.total} DZD`);
} else {
  console.log(`settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`);
}

// Now the avis itself. Two things are worth noticing about this call.
//
// It is addressed by **transaction**, never by housing file: there is no codeloc
// parameter and none is accepted. AADL's own export page hands a PDF to anyone who names
// a code, so proxying a caller-supplied one would turn this endpoint into a way to read
// other people's files; resolving the file from a transaction you own makes that
// impossible. If your code is building a codeloc here, it is calling the wrong thing.
//
// And it does not need SUCCESS. Unlike the receipt, any AADL transaction of yours that
// has resolved a bill can produce an avis — the READY discovery above would have done —
// because the two documents answer different questions. The receipt proves your payment
// went through; the avis is AADL's statement of what the file owes. Keep the receipt
// against your order, and hand the avis to the tenant.
try {
  const avis = await client.bills.avis(transactionId);
  console.log(`avis: ${avis.filename} (${avis.contentType}, ${avis.bytes.byteLength} bytes)`);
} catch (e) {
  if (e instanceof BillPayNotFoundError) {
    // This is what the live deployment answers today. The endpoint is documented in full
    // and implemented here against that contract, but it is not routed yet, so what comes
    // back is Fastify's own `{ message, error, statusCode }` — no `success`, no
    // `error.code`, nothing the house envelope promises. The SDK maps it by status onto
    // exactly the error a real 404 produces, which is why you are reading a clean
    // NOT_FOUND instead of a complaint about JSON nobody asked you to parse. The day the
    // route ships, this catch stops firing and the line above prints a PDF.
    //
    // One class, several sentences: the route missing, the transaction not being yours,
    // the transaction not being AADL's, and the file having no avis yet all arrive as
    // NOT_FOUND. Branch on the code, log the message — it is what tells them apart. That
    // router-level miss also carries no x-request-id, so requestId is null here; a
    // refusal from the application itself would have one, and support will want it.
    console.log(`avis unavailable: ${e.code} (HTTP ${e.httpStatus}) — ${e.message}`);
    console.log(`  requestId: ${e.requestId ?? 'none sent'}`);
  } else {
    throw e;
  }
}
