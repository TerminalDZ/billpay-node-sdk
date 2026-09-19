/**
 * The POST you never got an answer to, recovered with the discovery ref.
 *
 *   npm run build
 *   BILLPAY_API_KEY=08fa18ec-f6d4-4f44-905f-de9acbc96f21 \
 *     node --experimental-strip-types examples/recover-after-timeout.ts
 *
 * Nothing here is mocked. Both writes go to the real sandbox through a second client
 * whose deadline is shorter than the API's own latency, so the requests genuinely land
 * and the answers are genuinely lost — which is what a dropped proxy connection, a frozen
 * function or a phone leaving a tunnel look like from inside your process.
 *
 * The rule the whole file exists for: **a timeout tells you nothing about whether the
 * work happened.** Resending a POST to find out is how a customer gets charged twice.
 * Ask instead — and the discovery ref is what you ask with.
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

const apiKey = process.env.BILLPAY_API_KEY ?? '08fa18ec-f6d4-4f44-905f-de9acbc96f21';
const baseUrl = process.env.BILLPAY_BASE_URL;

const client = new BillPayClient({ apiKey, baseUrl });

// The same key and the same host, with an impossible deadline. 120 ms is under the
// quickest round trip this API gives — a warm GET runs about 150 ms and either POST
// 200-350 ms — and far above the time it takes to hand a request to a socket that is
// already open. So the server does the work and we never hear how it went.
//
// Note what does *not* rescue us: `retries`. The transport retries GETs only. A POST that
// creates a transaction cannot be replayed safely — the ref is rejected on reuse rather
// than replayed, so a blind second attempt either duplicates the work or fails with
// DUPLICATED_REF, and neither outcome says what became of the first one.
const impatient = new BillPayClient({ apiKey, baseUrl, timeoutMs: 120 });

const account = { reference: '0123456789012345678901234' } as const;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Also the call that opens the connection the impatient client will reuse: a cold TLS
// handshake costs around 140 ms here, which would eat the 120 ms budget before a single
// byte of the POST went out, and then we would be demonstrating a request that never left
// rather than one that was lost.
if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: that key is not a sandbox key, and this example pays.');
  process.exit(1);
}

// Write this down *before* the POST leaves. In your own system it is a row in your
// database, not a variable — if the process dies on the next line, this string is the
// only handle you have on whatever the API just did.
const discoveryRef = newRef('recover');
console.log(`discovery ref: ${discoveryRef}`);

try {
  await impatient.bills.discover({ partner: 'ADE', account, ref: discoveryRef });
  console.log('discover answered in time — the deadline was too generous today');
} catch (e) {
  if (!(e instanceof BillPayTimeoutError)) throw e;
  console.log(`discover: ${e.code} — no answer, and no way to know whether it landed`);
}

// Give the server the moment it may still be using. Reading immediately is its own trap:
// the request that timed out on your side can be halfway through the handler on theirs,
// and a status read inside that window is stale rather than final.
await sleep(1_500);

let transaction: Transaction;
try {
  // The only question worth asking, and getByRef is the only call that answers it. The
  // ref must be the discovery ref: that is the one the transaction keeps.
  transaction = await client.bills.getByRef({ ref: discoveryRef, partner: 'ADE' });
  console.log(`recovered: ${transaction.transactionId} is ${transaction.status} — it landed`);
} catch (e) {
  if (!(e instanceof BillPayNotFoundError)) throw e;
  // Nothing exists under that ref, so nothing was created and the request died before the
  // API saw it. This is the one circumstance in which sending again is safe — and it is
  // safe to send with the *same* ref. If the lookup was wrong and the first attempt did
  // land after all, the server answers 403 DUPLICATED_REF, which is a guard telling you
  // the work already exists. A fresh ref would have bought you a second transaction.
  console.log('not found by ref — it never landed; sending once more, same ref');
  const ack = await client.bills.discover({ partner: 'ADE', account, ref: discoveryRef });
  transaction = await client.bills.get(ack.transactionId);
}

const transactionId = transaction.transactionId;

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (!discovered.bills?.length) {
  console.log('Nothing payable on this account — stopping before the interesting part.');
  process.exit(0);
}

const bill = discovered.bills[0]!;
console.log(`bill: ${bill.billId} — ${bill.amount} DZD + ${bill.fee} fee`);

// The same accident, now on the call that moves money.
const payRef = payRefFor(discoveryRef);
try {
  await impatient.bills.pay({ transactionId, billId: bill.billId, ref: payRef });
  console.log('pay answered in time — the deadline was too generous today');
} catch (e) {
  if (!(e instanceof BillPayTimeoutError)) throw e;
  console.log(`pay: ${e.code} — the money may or may not have moved`);
}

await sleep(1_500);

// Ask with the discovery ref again, never with the ref you just sent to pay. That one is
// validated and then discarded: the transaction keeps the ref it was discovered with. The
// mistake is worth seeing rather than being told about, so here it is out loud — a
// perfectly healthy payment, reported as missing, by a lookup asking the wrong question.
try {
  await client.bills.getByRef({ ref: payRef, partner: 'ADE' });
  console.log('by pay ref: resolved — the server has started keeping pay refs');
} catch (e) {
  if (!(e instanceof BillPayNotFoundError)) throw e;
  console.log(`by pay ref: ${e.code} — as designed; a pay ref is a handle on nothing`);
}

const after = await client.bills.getByRef({ ref: discoveryRef, partner: 'ADE' });

if (after.status === 'READY') {
  // The only status that proves the payment never started. Every other one means
  // something is running or has run, and sending again would be the second charge.
  console.log('still READY — the pay never landed; sending it once, with a fresh pay ref');
  await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });
} else if (!isTerminal(after.status)) {
  // PROCESSING, or UNKNOWN. Both mean in flight; neither is a reason to touch it. Poll.
  console.log(`${after.status} — in flight; keep polling, and do not resend`);
} else {
  // The sandbox settles in well under a second, so this is usually the branch you land
  // on here. Production takes longer and will more often hand you PROCESSING above.
  console.log(`${after.status} — it had already settled before we asked`);
}

const settled = isTerminal(after.status)
  ? after
  : await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });

console.log(
  `final: ${settled.status}` +
    (settled.status === 'SUCCESS' ? ` — debited ${settled.total} DZD` : ''),
);

// Two writes were lost and the bill was paid exactly once. Nothing above retried a POST;
// every recovery was a read.
