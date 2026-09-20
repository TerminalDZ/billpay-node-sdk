# @terminaldz/billpay-sdk

Node.js/TypeScript SDK for the **OneClickDz Bill Payment API** (`/v3`): discover what an
Algerian utility or telecom account owes (ADE, SONELGAZ, SEAAL, AADL, Algérie Télécom),
pay one bill or several as one order, follow the payment to its outcome, download the
receipt.

Zero runtime dependencies, no `node:` imports: one build for Node 18+ and browsers.
Ships ESM, CommonJS and type declarations.

API reference: <https://docs.oneclickdz.com>

## Install

```bash
npm install @terminaldz/billpay-sdk
```

## Quickstart

```ts
import { BillPayClient, newRef, payRefFor } from '@terminaldz/billpay-sdk';

const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });

// 1. Discover
const discoveryRef = newRef('order-12345');
const { transactionId } = await client.bills.discover({
  partner: 'ADE',
  account: { electronic_payment_key: '0123456789012345678901234' },
  ref: discoveryRef,
});

// 2. Read the bills
const discovered = await client.bills.waitForReady(transactionId);
const bill = discovered.bills?.[0];
if (!bill) throw new Error('nothing to pay');

// 3. Pay (a new ref for the payment)
await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });

// 4. Confirm and download the receipt
const settled = await client.bills.waitForTerminal(transactionId);
if (settled.status === 'SUCCESS') {
  const receipt = await client.bills.receipt(transactionId);
  // receipt.bytes, receipt.contentType, receipt.filename
}
```

`https://api.oneclickdz.com` serves both environments; the key decides. `client.environment()`
returns `'SANDBOX'` or `'PRODUCTION'`.

## Two rules

- **`discover()` and `pay()` return acknowledgements, not outcomes.** The outcome is the
  transaction's `status`. Use `waitForReady()` and `waitForTerminal()`.
- **Never resend a payment.** After a timeout or an error you do not understand, read the
  transaction (`getByRef()` with the discovery ref, or `get()`) before doing anything else.

## Accounts

`account` carries exactly one identifier; the types make a second one a compile error.

| Partner           | `account`                                                         |
| ----------------- | ----------------------------------------------------------------- |
| `ADE`             | `{ electronic_payment_key }` — 25 characters                      |
| `SONELGAZ`        | `{ sonelgaz: { invoice_number, amount_without_stamp, ebb_key } }` |
| `SEAAL`           | `{ seaal: { code_client, code_contrat } }`                        |
| `AADL`            | `{ aadl: { codeloc } }` — 6–20 digits                             |
| `Algérie Télécom` | `{ phone_number }` — landline, `0[2-4]` then 7 digits             |

Responses echo the identifier flat under a partner-specific key (`reference`,
`contractNumber`, `codeClient`, `codeloc`, `phoneNumber`). Those keys are output only.

`client.partners()` returns each partner's availability; read it when building the picker.

## Paying several bills

```ts
await client.bills.pay({ transactionId, billIds: bills.map((b) => b.billId), ref: payRefFor(ref) });
```

1 to 50 distinct ids from the transaction's `bills`, settled as one order with one fee on
the combined amount. On the transaction, `selectedBill` is the aggregate and
`selectedBills` lists each bill. SEAAL accounts commonly carry several unpaid quarters.

## Statuses

| Status       | Meaning                                                 | Final |
| ------------ | ------------------------------------------------------- | ----- |
| `PENDING`    | Discovery in progress                                   | No    |
| `READY`      | `bills` available (empty when nothing is due)           | No    |
| `PROCESSING` | Payment in progress                                     | No    |
| `UNKNOWN`    | Outcome not yet confirmed; becomes `SUCCESS`/`REFUNDED` | No    |
| `SUCCESS`    | Paid; `receiptUrl` and `operationId` set                | Yes   |
| `FAILED`     | Not paid, nothing debited; see `error`                  | Yes   |
| `REFUNDED`   | Debited then fully refunded; see `error`                | Yes   |

`waitForTerminal()` keeps polling through `UNKNOWN`. Bound the wait with `timeoutMs` and
catch `BillPayPollTimeoutError`: the transaction is still in progress, so queue it for a
background check rather than refunding or resending. `onPoll` receives every read.

Money: `bill.amount + bill.fee` per bill; `transaction.total` is what is debited. Fees are
configured per partner: display the API's values, never recompute them.

## Refs

- Required on `discover` and `pay`, max 100 characters, unique per partner. Reuse answers
  `403 DUPLICATED_REF`. `newRef(prefix?)` generates one.
- `pay` needs a ref distinct from the discovery ref. `payRefFor(discoveryRef)` derives one.
- The transaction keeps the discovery ref; `getByRef()` resolves that one only.

Recovery after a timed-out `discover`: `getByRef({ ref })` — `BillPayNotFoundError` means
it was never created, so send it again with the same ref. After a timed-out `pay`: `get()`
— `READY` means the pay never landed; anything else means it did.

## Errors

Every failure is a `BillPayError` with `code`, `httpStatus`, `requestId`, `retryAfter`,
`details` and `isRetryable`.

| Class                     | Codes                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `BillPayAuthError`        | `MISSING_ACCESS_TOKEN`, `INVALID_ACCESS_TOKEN`, `ERR_AUTH`, `IP_BLOCKED`, `IP_NOT_ALLOWED`, `API_DISABLED` |
| `BillPayValidationError`  | `ERR_VALIDATION`, `INVALID_ACCOUNT`, `PAYLOAD_TOO_LARGE`, local checks                                     |
| `BillPayConflictError`    | `DUPLICATED_REF`, `BILL_ALREADY_PAID`, `PAYMENT_IN_PROGRESS`                                               |
| `BillPayNotFoundError`    | `NOT_FOUND` (unknown, not yours, wrong environment, not payable)                                           |
| `BillPayUnavailableError` | `AUTH_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `PARTNER_UNAVAILABLE`                                           |
| `BillPayRateLimitError`   | `RATE_LIMIT_EXCEEDED`                                                                                      |
| `BillPayInternalError`    | `INTERNAL_ERROR`, other 5xx                                                                                |
| `BillPayTimeoutError`     | `TIMEOUT` — no response within `timeoutMs`                                                                 |
| `BillPayNetworkError`     | `NETWORK`                                                                                                  |
| `BillPayAbortError`       | `ABORTED` — the caller's `AbortSignal` fired                                                               |
| `BillPayPollTimeoutError` | `POLL_TIMEOUT` — `transactionId`, `lastStatus`                                                             |

GETs are retried on 5xx, 429 and network errors (`retries`, default 2). POSTs are never
retried.

## Downloads

- `bills.receipt(id)` — after `SUCCESS`. PDF, PNG or JPEG (`contentType`); sandbox
  receipts are PNG.
- `bills.avis(id)` — AADL's avis de paiement (PDF), from `READY` onwards. `NOT_FOUND` for
  other partners and in the sandbox.

Both return `{ bytes, contentType, filename, requestId }`. In browsers `filename` falls
back to `receipt-<id>.<ext>` / `avis_<id>.pdf` and `requestId` is `null` (the headers are
not CORS-exposed). Consumers need TypeScript 5.7+ (`bytes` is `Uint8Array<ArrayBuffer>`).

## Browsers

The ESM entry is the browser entry. A key shipped to a browser is a key you have
published: use a sandbox key there and keep the production key behind your own server.

## Sandbox

Same host, routes and lifecycle as production; no biller is contacted and no money moves.
The identifier selects the outcome (discovery in about 0.2 s, payment in about 0.5 s).

| Partner         | Identifier                   | Outcome                                    |
| --------------- | ---------------------------- | ------------------------------------------ |
| ADE             | `0123456789012345678901234`  | 1 bill → `SUCCESS`                         |
| ADE             | `0123456789012340000000002`  | `READY`, `bills: []`                       |
| ADE             | `0123456789012340000000004`  | `FAILED` / `PAYMENT_DECLINED`              |
| ADE             | `0123456789012340000000005`  | `REFUNDED` / `PAYMENT_DECLINED`            |
| ADE             | `0123456789012340000000006`  | `409 BILL_ALREADY_PAID`                    |
| ADE             | `0123456789012345005005005`  | `503 PARTNER_UNAVAILABLE`                  |
| ADE             | `abc0000000000000000000000`  | `400 INVALID_ACCOUNT`                      |
| SONELGAZ        | `invoice_number: 9876543210` | 2 bills → `SUCCESS` (multi-bill)           |
| SONELGAZ        | `invoice_number: 4004004004` | `FAILED` / `PAYMENT_DECLINED`              |
| SONELGAZ        | `invoice_number: 6006006006` | `UNKNOWN` (~60 s) → `REFUNDED`             |
| SEAAL           | `code_client: 100001`        | 5 quarterly bills → `SUCCESS` (multi-bill) |
| SEAAL           | `code_client: 100003`        | `READY`, `bills: []`                       |
| SEAAL           | `code_client: 100005`        | `400 INVALID_ACCOUNT`                      |
| AADL            | `codeloc: 1112223334`        | 1 notice with `breakdown` → `SUCCESS`      |
| AADL            | `codeloc: 4445556667`        | `409 BILL_ALREADY_PAID`                    |
| Algérie Télécom | `phone_number: 023456789`    | 1 bill → `SUCCESS`                         |

Any other identifier returns one bill of 500.00 DZD and a successful payment. The full
list is in the [sandbox guide](https://docs.oneclickdz.com/en/bill-payment-guides/6-sandbox-testing).

## Examples

```bash
npm run build
BILLPAY_API_KEY=<sandbox key> node --experimental-strip-types examples/pay-a-bill.ts
```

`examples/pay-a-bill.ts`, `seaal-quarters.ts` (multi-bill), `aadl-avis.ts` (breakdown and
notice), `recover-after-timeout.ts`. Each refuses to run with a non-sandbox key.

## Configuration

```ts
new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY!,
  baseUrl: 'https://api.oneclickdz.com', // default
  timeoutMs: 15_000, // per request
  retries: 2, // GET only
  fetch: myFetch, // optional
  onRequest: ({ method, path }) => {},
  onResponse: ({ method, path, status, requestId, durationMs }) => {},
});
```

Hooks never receive headers or the key. Clients hold no global state.

## Notes on the wire

- `list()` receives a bare array in `data`; counts come from `meta` and fall back to the
  page when absent.
- `GET /v3/validate` sends no `meta`.
- `ref` as a `list()` filter is ignored by the API; use `getByRef()`.

## Development

```bash
npm install
npm run test:all          # lint, typecheck, unit tests (no network)
npm run build
BILLPAY_SANDBOX_KEY=<sandbox key> npm run test:integration   # live sandbox
```

The integration suite skips without a sandbox key and refuses a production key.

## License

MIT
