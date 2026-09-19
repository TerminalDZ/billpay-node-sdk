/**
 * The whole flow: discover → pick a bill → pay → wait → download the receipt.
 *
 *   npm run build
 *   BILLPAY_API_KEY=08fa18ec-f6d4-4f44-905f-de9acbc96f21 \
 *     node --experimental-strip-types examples/pay-a-bill.ts
 *
 * Uses the sandbox key against the real API — sandbox and production share one host, so
 * the key is what keeps this harmless: no portal is touched and no money moves.
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
  BillPayPollTimeoutError,
  newRef,
  payRefFor,
} from '@terminaldz/billpay-sdk';

const client = new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY ?? '08fa18ec-f6d4-4f44-905f-de9acbc96f21',
  // Omitted on purpose: the default base URL serves both environments.
  baseUrl: process.env.BILLPAY_BASE_URL,
});

// The environment lives at apiKey.type — the only trustworthy "is this real money?".
// The URL cannot tell you, because both environments answer on the same host. Take the
// two fields you need rather than logging the result whole: apiKey.key is the credential.
const { apiKey } = await client.validate();
console.log(`key: ${apiKey.type}, scope ${apiKey.scope}`);

if (apiKey.type !== 'SANDBOX') {
  // This file pays a bill from end to end. Stopping here costs a second; explaining a
  // production charge to somebody who ran an example costs rather more.
  console.error('Refusing to run: that key is not a sandbox key, and this example pays.');
  process.exit(1);
}

// One ref for the discovery. Keep it: it is the only ref that resolves later. Generate it
// before the POST leaves and — in your own system, not in an example — write it down
// first, because if the answer is lost this string is your only handle on the
// transaction. That recovery is a file of its own: see recover-after-timeout.ts.
const discoveryRef = newRef('example');
const { transactionId } = await client.bills.discover({
  partner: 'ADE',
  account: { reference: '0123456789012345678901234' },
  ref: discoveryRef,
});
console.log(`discovery started: ${transactionId} (ref ${discoveryRef})`);

// The 200 above was an acknowledgement — its status is always PENDING. Bills only ever
// arrive on the transaction, so the poll is the mechanism here, not an optimisation.
const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });
if (!discovered.bills?.length) {
  console.log('Nothing payable — either nothing is due, or it is under the 200 DZD floor.');
  process.exit(0);
}

// ADE returns a single bill; SONELGAZ can return several, and then this is the line where
// your customer chooses. A payment pays exactly one.
const bill = discovered.bills[0]!;

// Three numbers, three meanings: `amount` is what the biller is owed, `fee` is what we
// charge to pay it, and `total` — which the transaction reports once a bill is selected —
// is what leaves your balance. Sandbox always answers `fee: 0`, so the first two agree
// here and part company on the day you go live. Show both to the customer, and never
// recompute either: the fee is configuration, not a constant.
console.log(
  `bill: ${bill.billId} — ${bill.amount} DZD + ${bill.fee} fee` +
    `${bill.label ? ` (${bill.label})` : ''}`,
);

try {
  // The pay ref is a convention worth keeping, not a rule the server enforces: the live
  // deployment accepts the discovery ref here and answers 200 PROCESSING, whatever the
  // published 403 says. A distinct ref keeps your own logs honest about which call you
  // are reading, and costs nothing the day the documented behaviour arrives.
  await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });

  // UNKNOWN is not a failure and not terminal — waitForTerminal keeps polling through it.
  const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });

  if (settled.status !== 'SUCCESS') {
    // FAILED means nothing was charged. REFUNDED means it was charged and came back in
    // full. Your customer hears the same sentence — the bill is not paid — but only one
    // of the two puts two movements in your ledger.
    console.log(`settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`);
    process.exit(0);
  }

  console.log(`settled: SUCCESS — debited ${settled.total} DZD, operation ${settled.operationId}`);

  // receiptUrl is set on every SUCCESS even when no bytes exist, so this can still 404.
  try {
    const receipt = await client.bills.receipt(transactionId);
    console.log(
      `receipt: ${receipt.filename} (${receipt.contentType}, ${receipt.bytes.byteLength} bytes)`,
    );
  } catch (e) {
    if (e instanceof BillPayNotFoundError)
      console.log('receipt: not available for this transaction');
    else throw e;
  }
} catch (e) {
  // Specific first. Every class here descends from BillPayError, so hoisting that branch
  // above the others would quietly swallow them.
  if (e instanceof BillPayPollTimeoutError) {
    // The foreground wait ran out. The transaction did not: it is still moving, and
    // `lastStatus` says where it was when we stopped watching — usually UNKNOWN, which is
    // where the expensive mistakes live. UNKNOWN is not a failure. It resolves on its own
    // to SUCCESS or REFUNDED, and the review behind it is manual and can take hours. So
    // hold the customer's funds, show "being confirmed" rather than "failed", and hand
    // the id to a background job that checks every half hour. Refunding here pays a bill
    // you never collected for; resending pays it twice.
    //
    // To watch this branch fire, discover SONELGAZ with a `sonelgaz` identifier — all
    // three of its fields are required — whose invoice_number is '6006006006'. The
    // sandbox parks that one on UNKNOWN for about a minute before resolving it to
    // REFUNDED; set the timeout above below that and this is what you get.
    console.log(
      `not settled in the foreground (last status ${e.lastStatus}) — holding the funds ` +
        `and queueing ${e.transactionId} for reconciliation`,
    );
  } else if (e instanceof BillPayConflictError) {
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
