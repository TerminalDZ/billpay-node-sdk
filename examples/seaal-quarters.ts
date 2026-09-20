/**
 * SEAAL, end to end: look a water account up by its code_client / code_contrat pair,
 * read the outstanding quarters, settle one, and fetch the receipt.
 *
 *   npm run build
 *   BILLPAY_API_KEY=08fa18ec-f6d4-4f44-905f-de9acbc96f21 \
 *     node --experimental-strip-types examples/seaal-quarters.ts
 *
 * Two things make SEAAL unlike the others, and this file is built around both.
 *
 * **The identifier is a pair, and both halves are mandatory.** There is no flat
 * shorthand — no `reference`, no single key of any kind — because the portal
 * authenticates on the two numbers together. Both are printed on the customer's paper
 * water bill: `code_client` is 2 to 6 alphanumeric characters, `code_contrat` is 2 to 10
 * digits.
 *
 * **A water account owes quarters, plural.** Billing is quarterly and nothing forces a
 * household to settle each one as it lands, so a real account verified in production had
 * 45 open factures at once. This is the partner a multi-select bill picker was invented
 * for — the opposite of AADL, whose one aggregate avis renders a list of one forever.
 *
 * Scope limit, stated before you build on it: `/v3` pays exactly one `billId` per call.
 * Selecting several factures as a single portal order — one card payment, one fee on the
 * total — is a B2C capability and is not on this surface. There is no `bill_ids` here,
 * and writing one would be inventing an endpoint.
 *
 * Set BILLPAY_SEAAL_CODE_CLIENT to walk the sandbox scenarios; the values are listed next
 * to the constant.
 */

import {
  BillPayClient,
  BillPayConflictError,
  BillPayNotFoundError,
  BillPayValidationError,
  newRef,
  payRefFor,
  type Bill,
} from '@terminaldz/billpay-sdk';

const client = new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY ?? '08fa18ec-f6d4-4f44-905f-de9acbc96f21',
  baseUrl: process.env.BILLPAY_BASE_URL,
});

/**
 * The client code: 2 to 6 alphanumeric characters, `^[A-Za-z0-9]{2,6}$`. The sandbox
 * keys its scenarios off this half of the pair, so each value below is a different
 * shape of answer:
 *
 *   100001  five unpaid quarterly factures — the signature SEAAL shape   (the default)
 *   100002  exactly one outstanding facture
 *   100003  a fully settled account — READY with an empty bills[]
 *   100004  discovery succeeds, and the gateway declines the card at payment
 *   100005  the portal rejects the pair — 400 INVALID_ACCOUNT, synchronously
 */
const codeClient = process.env.BILLPAY_SEAAL_CODE_CLIENT ?? '100001';

/** The contract code: 2 to 10 digits, `^\d{2,10}$`. Not a scenario selector. */
const codeContrat = process.env.BILLPAY_SEAAL_CODE_CONTRAT ?? '446547';

// One field, and it is the only one that decides whether this run can charge anybody.
if ((await client.environment()) !== 'SANDBOX') {
  console.error('Refusing to run: that key is not a sandbox key, and this example pays.');
  process.exit(1);
}

// Ask, rather than assume. Availability changes in both environments without an SDK
// release and this map is the only honest record of it — including for SEAAL, which the
// SDK spent a release documenting as permanently unavailable and which now answers in
// about 190 ms. Build the partner picker from this call, never from a document.
const partners = await client.partners();
console.log(`SEAAL: ${partners['SEAAL']?.status ?? 'not listed'}`);
if (partners['SEAAL']?.status !== 'ACTIVE') {
  console.log(
    'SEAAL is not taking payments right now — hide it in your UI rather than fail later.',
  );
  process.exit(0);
}

const discoveryRef = newRef('seaal');
let transactionId: string;

try {
  // The identifier is exactly this and nothing else: the two codes, nested inside
  // `seaal`. Sending one without the other is a validation failure naming the half you
  // left out — "seaal.code_client must be 2 to 6 alphanumeric characters" or
  // "seaal.code_contrat must be 2 to 10 digits" — and there is no flat form to fall back
  // on, which the type makes a compile error rather than a 400 you meet in front of a
  // customer.
  const ack = await client.bills.discover({
    partner: 'SEAAL',
    account: { seaal: { code_client: codeClient, code_contrat: codeContrat } },
    ref: discoveryRef,
  });
  transactionId = ack.transactionId;
  console.log(`discovery started: ${transactionId} (ref ${discoveryRef})`);
} catch (e) {
  if (e instanceof BillPayConflictError && e.code === 'BILL_ALREADY_PAID') {
    // The account-level double-pay guard: something on this water account was already
    // settled inside the dedupe window. It is an answer, not a failure, and retrying
    // with a fresh ref changes nothing except your rate limit.
    console.log(`account ${codeClient}: already settled — ${e.message}`);
    process.exit(0);
  }
  if (e instanceof BillPayValidationError && e.code === 'INVALID_ACCOUNT') {
    // The portal refused the pair. Send the customer back to the paper bill: it is the
    // combination that failed, so either half could be the wrong one.
    console.log(`the portal rejected this SEAAL account — ${e.message}`);
    process.exit(0);
  }
  throw e;
}

const discovered = await client.bills.waitForReady(transactionId, { timeoutMs: 60_000 });

// The pair goes out nested and a single key comes home: `codeClient`, flat. Not
// `reference` — that one is ADE's. Every partner echoes its own one key this way.
console.log(`account: ${discovered.account.codeClient ?? codeClient}`);

// `waitForReady` resolves on READY *or* on a terminal status, so a discovery that died
// upstream arrives here as FAILED — with `bills` absent, which looks exactly like the
// settled account below if you do not check the status first. Congratulating a customer
// on being paid up when the lookup actually failed is the whole reason this branch
// exists before the empty-list one.
if (discovered.status !== 'READY') {
  // `PARTNER_UNAVAILABLE` is what a SEAAL account lockout becomes on `/v3`: the portal
  // says "Compte temporairement bloqué. Réessayez dans 4 heure(s)." after repeated
  // attempts on one account, and the platform maps that to the same code it uses for a
  // genuine portal outage. From here the two are indistinguishable — so say "temporarily
  // unavailable, try later", never "your codes are wrong", and do not hammer it: if it
  // is a lockout, more attempts lengthen it.
  console.log(`discovery did not complete: ${discovered.status} — ${discovered.error?.code}`);
  process.exit(0);
}

if (!discovered.bills?.length) {
  // An empty list is a result, not an error: the account is fully settled — the portal's
  // own words are "Vous êtes à jour, merci pour votre fidélité." Say so.
  console.log('Nothing outstanding on this account — no quarter to pay.');
  process.exit(0);
}

const dzd = (n: number): string => `${n.toFixed(2)} DZD`;

// This is the screen SEAAL needs and AADL does not. Every entry is separately payable,
// and `billId` is the invoice number itself — `numero_fac`, e.g. F059107046 — so there
// is no lookup between what you show here and what you pay with.
console.log(`${discovered.bills.length} outstanding facture(s):`);
for (const bill of discovered.bills) {
  console.log(
    `  ${bill.billId}${bill.period ? ` — ${bill.period}` : ''}` +
      ` — ${dzd(bill.amount)} + ${dzd(bill.fee)} fee`,
  );
}

// Whichever one the customer picked; this file takes the first.
//
// It settles that facture and no other. On `/v3` one payment is one order, so paying a
// second quarter is a second call carrying its own fee — the single-order, single-fee
// arithmetic belongs to the B2C multi-select and quoting it here would overstate what
// this endpoint does. Never recompute the number yourself either: the published rule for
// SEAAL is 2.5% with a 10 DZD floor and a 50 DZD ceiling, but the fee is configuration
// and the bill already carries it. Sandbox answers `fee: 0`, so the two agree here and
// part company the day you go live.
const chosen: Bill = discovered.bills[0]!;

// The portal has a floor of its own, and it is not the SDK's: an order below 100 DA is
// refused upstream with "Le montant total sélectionné doit être au moins de 100 DA".
// One bill is one order here, so it is this bill's amount the floor applies to.
if (chosen.amount < 100) {
  console.log(`${dzd(chosen.amount)} is under SEAAL's 100 DA order minimum — not payable alone.`);
  process.exit(0);
}

await client.bills.pay({ transactionId, billId: chosen.billId, ref: payRefFor(discoveryRef) });
const settled = await client.bills.waitForTerminal(transactionId, { timeoutMs: 120_000 });

if (settled.status !== 'SUCCESS') {
  // FAILED means nothing was charged; REFUNDED means it was charged and came back whole.
  console.log(`settled: ${settled.status} — ${settled.error?.code}: ${settled.error?.message}`);
  process.exit(0);
}

console.log(`settled: SUCCESS — debited ${settled.total} DZD, operation ${settled.operationId}`);

// Reconciliation against SEAAL is by absence: a facture that has been paid simply stops
// being returned in the unpaid list. There is no paid flag to read, so a later discovery
// on the same account — one quarter shorter — is the confirmation.
try {
  // The receipt carries SEAAL's own "Numéro d'opération SEAAL", the biller-side id for
  // the payment, alongside SATIM's "Numéro de transaction" and "Numéro d'autorisation".
  // Three different numbers for one payment: quote the SEAAL one to SEAAL.
  const receipt = await client.bills.receipt(transactionId);
  console.log(
    `receipt: ${receipt.filename} (${receipt.contentType}, ${receipt.bytes.byteLength} bytes)`,
  );
} catch (e) {
  if (e instanceof BillPayNotFoundError) console.log('receipt: not available for this transaction');
  else throw e;
}
