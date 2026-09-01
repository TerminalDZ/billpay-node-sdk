# @terminaldz/billpay-sdk

The official Node.js/TypeScript SDK for the **OneClickDz Bill Payment API** (`/v3`).

Pay Algerian utility and telecom bills — ADE, SONELGAZ, SEAAL, AADL and Algérie
Télécom — through one API: discover what an account owes, pay one of the discovered
bills, wait for the outcome, download the receipt.

Zero runtime dependencies. Node 18+. Ships CommonJS, ESM and type declarations.

Full API reference: <https://docs.oneclickdz.com>

---

## Install

```bash
npm install @terminaldz/billpay-sdk
```

## Quickstart

```ts
import { BillPayClient } from '@terminaldz/billpay-sdk';

const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });
const { key } = await client.validate();
console.log(key.type); // 'SANDBOX' | 'PRODUCTION'
```

The base URL defaults to production. Point it at a sandbox stack with
`baseUrl: 'http://localhost:3100'`.

---

## The one thing to understand first

**This API is asynchronous.** A `200` from `discover` or `pay` is an *acknowledgement*
that the work started — never an outcome. Discover returns `PENDING`; pay returns
`PROCESSING`. You find out what actually happened by polling.

Everything else in this SDK follows from that.

## The full flow

```ts
import { BillPayClient, newRef, payRefFor, BillPayNotFoundError } from '@terminaldz/billpay-sdk';

const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });

// 1. Discover. Keep this ref — it is the only one that resolves later.
const discoveryRef = newRef('order-12345');
const { transactionId } = await client.bills.discover({
  partner: 'ADE',
  account: { reference: '0123456789012345678901234' },
  ref: discoveryRef,
});

// 2. Wait for discovery to finish, then read the bills.
const discovered = await client.bills.waitForReady(transactionId);
if (!discovered.bills?.length) return; // nothing payable

// 3. Pay one bill. The pay ref MUST differ from the discovery ref.
const bill = discovered.bills[0];
await client.bills.pay({ transactionId, billId: bill.billId, ref: payRefFor(discoveryRef) });

// 4. Wait for the real outcome. Holds through UNKNOWN.
const settled = await client.bills.waitForTerminal(transactionId);

if (settled.status === 'SUCCESS') {
  try {
    const receipt = await client.bills.receipt(transactionId);
    await writeFile(receipt.filename, receipt.bytes);
  } catch (e) {
    if (!(e instanceof BillPayNotFoundError)) throw e; // receipts can legitimately 404
  }
} else {
  console.log(settled.error?.code, settled.error?.message);
}
```

A runnable version is in [`examples/pay-a-bill.ts`](./examples/pay-a-bill.ts).

---

## Statuses

| Status | Meaning |
| --- | --- |
| `PENDING` | Discovery started, not finished. |
| `READY` | Discovery finished — read `bills`. |
| `PROCESSING` | Payment in flight. |
| `UNKNOWN` | Outcome under review. **Not** a failure, **not** terminal. |
| `SUCCESS` | Paid. `receiptUrl` and `operationId` are set. |
| `FAILED` | Not paid. Read `error`. |
| `REFUNDED` | Money was taken and returned. Read `error`. |

Terminal: `SUCCESS`, `FAILED`, `REFUNDED`.

### `UNKNOWN` is not a failure

`UNKNOWN` means the payment's outcome could not be confirmed yet and is being
reviewed. It always resolves to `SUCCESS` or `REFUNDED`.

Treating it as a failure is the most expensive mistake an integration can make — you
will tell a customer their payment failed while it is on its way to succeeding.
`waitForTerminal` keeps polling through `UNKNOWN` and never resolves on it. If you
poll yourself, use the exported `isTerminal()` rather than a hand-written list.

### `READY` with no bills is a normal result

An empty `bills` array means nothing is payable. That covers both "nothing is due"
and "everything owed is under the 200 DZD discovery floor". It is not an error, and
there is no `NO_BILLS_FOUND` code — despite what `openapi.yaml` suggests.

---

## The `ref` rules

`ref` is your idempotency key. It is **required** on both discover and pay, capped at
**100 characters**, and must be unique per (account, partner). A clash answers
`403 DUPLICATED_REF`. Refs belonging to `FAILED` or refunded transactions become
reusable.

Two rules matter more than the rest:

**1. The pay ref must differ from the discovery ref.** The discovery transaction is
still live when you pay it, so its ref is still taken. Use `payRefFor(discoveryRef)`.

**2. The pay ref is validated and then discarded.** The transaction keeps its
*discovery* ref. So:

```ts
const ack = await client.bills.pay({ transactionId, billId, ref: payRef });
ack.ref === discoveryRef;   // ← the DISCOVERY ref, not the one you just sent

await client.bills.getByRef({ ref: discoveryRef }); // ✅ resolves
await client.bills.getByRef({ ref: payRef });       // ❌ 404, always
```

Store the discovery ref. The pay ref is write-only.

> Note: this rule is enforced in **production** but not in sandbox — sandbox pay skips
> the ref check entirely. An integration validated only against sandbox will meet
> `403 DUPLICATED_REF` on its first production payment. `payRefFor()` keeps you right
> in both.

### Never blindly retry a POST

`discover` and `pay` create transactions, and reusing a ref is *rejected* rather than
replayed. So a blind retry after a timeout either duplicates work or fails with
`DUPLICATED_REF` — and tells you nothing about whether the first attempt landed.

This SDK **never retries a POST**. When one fails at the transport level, ask the API
what happened using the ref you sent:

```ts
try {
  await client.bills.discover({ partner: 'ADE', account, ref });
} catch (e) {
  if (e instanceof BillPayError && e.isRetryable) {
    const existing = await client.bills.getByRef({ ref, partner: 'ADE' });
    // Resolved → the POST landed. 404 → it did not; safe to send again.
  }
}
```

GETs *are* retried automatically (twice by default, honouring `Retry-After`).

---

## Errors

Every failure throws a typed error extending `BillPayError`, which carries `code`,
`httpStatus`, `requestId`, `retryAfter` and `details`. The API key never appears in a
message, a property or a stack.

| Class | Codes |
| --- | --- |
| `BillPayAuthError` | `MISSING_ACCESS_TOKEN`, `INVALID_ACCESS_TOKEN` |
| `BillPayValidationError` | `ERR_VALIDATION`, `INVALID_ACCOUNT`, `PAYLOAD_TOO_LARGE` |
| `BillPayConflictError` | `DUPLICATED_REF`, `BILL_ALREADY_PAID`, `PAYMENT_IN_PROGRESS` |
| `BillPayUnavailableError` | `AUTH_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `PARTNER_UNAVAILABLE` |
| `BillPayNotFoundError` | `NOT_FOUND` |
| `BillPayInternalError` | `INTERNAL_ERROR` |
| `BillPayTimeoutError` | request exceeded `timeoutMs` |
| `BillPayNetworkError` | the request never reached the API |
| `BillPayAbortError` | your `AbortSignal` fired |
| `BillPayPollTimeoutError` | a polling helper gave up; read `lastStatus` |

**`AUTH_UNAVAILABLE` is not an auth failure.** It means the API could not verify your
key in time. Your key is fine — retry after `retryAfter` seconds. It is deliberately
*not* a `BillPayAuthError`, so you never rotate a credential that was never the problem.

**A transaction belonging to another partner returns `404`, not `403`.** The API does
not confirm that someone else's id exists.

Inside a `FAILED` or `REFUNDED` transaction, `error.code` is one of
`PAYMENT_DECLINED`, `PARTNER_UNAVAILABLE`, `INVALID_ACCOUNT`, `BILL_ALREADY_PAID`.

---

## Partners and accounts

| Partner | Account field |
| --- | --- |
| `ADE` | `reference` |
| `SEAAL` | `reference` |
| `SONELGAZ` | `contractNumber` |
| `AADL` | `aadlNumber` |
| `Algérie Télécom` | `phoneNumber` |

`'Algérie Télécom'` carries its accents — it is the literal value the API matches.

An account carries **exactly one** identifier. The union type makes two a compile-time
error:

```ts
{ reference: '…' }                      // ✅
{ reference: '…', contractNumber: '…' } // ❌ does not compile
```

The nested invoice forms (`sonelgaz{}`, `ade{}`) and the snake_case forms
(`electronic_payment_key`, exactly 25 characters; `phone_number`) are also accepted.
Responses always echo the camelCase form.

`SEAAL` and `AADL` are currently disabled and answer `503 PARTNER_UNAVAILABLE`. Check
`client.partners()` before offering a partner rather than finding out at payment time.

### Receipts can 404

`receiptUrl` is set on **every** `SUCCESS`, including when the manager holds no bytes
for it. Always handle `BillPayNotFoundError` from `receipt()`; never treat the presence
of a URL as a promise that a file exists.

---

## Sandbox scenarios

Sandbox keys use the same routes, envelope and lifecycle as production, touch no portal
and move no money. The **account identifier selects the outcome**, so every scenario is
deterministic.

| Scenario | Partner | Account | Outcome |
| --- | --- | --- | --- |
| Happy path | ADE | `reference: 0123456789012345678901234` | `READY`, 1 bill @ 443.39 → `SUCCESS` |
| Multi-bill | SONELGAZ | `sonelgaz{invoice_number: 9876543210, …}` | `READY`, 2 bills |
| Nothing due | ADE | `reference: 0123456789012340000000002` | `READY`, `bills: []` |
| Below the 200 DZD floor | ADE | `reference: 0123456789012341111111111` | `READY`, `bills: []` |
| Declined | ADE | `reference: 0123456789012340000000004` | `FAILED` / `PAYMENT_DECLINED` |
| Refunded | ADE | `reference: 0123456789012340000000005` | `REFUNDED` |
| Under review | SONELGAZ | `sonelgaz{invoice_number: 6006006006, …}` | `UNKNOWN` (~60 s) → `REFUNDED` |
| Invalid account | ADE | `reference: abc0000000000000000000000` | `400 INVALID_ACCOUNT` |
| Partner down | AADL | `aadlNumber: 1112223334` | `503 PARTNER_UNAVAILABLE` |
| Already paid | ADE | `reference: 0123456789012347777777777` | `409 BILL_ALREADY_PAID` |

---

## Configuration

```ts
new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY!,
  baseUrl: 'https://billapi.oneclickdz.com', // default
  timeoutMs: 15_000,                          // per request
  retries: 2,                                 // GET only, never POST
  fetch: myFetch,                             // optional, for tests
  onRequest:  ({ method, path }) => {},
  onResponse: ({ method, path, status, requestId, durationMs }) => {},
});
```

Hooks receive method, path, status, `requestId` and duration — never headers, never
your key. Clients hold no global state, so a sandbox client and a production client can
run side by side.

---

## Known drift from `openapi.yaml`

The published spec disagrees with the implementation in several places. This SDK
follows the **implementation**, which is what you will actually receive.

| `openapi.yaml` says | The API does |
| --- | --- |
| list returns `data: { transactions: [...] }` | `data` is a bare array; counts are in `meta` |
| discover 200 → `{ transactionId, status, createdAt }` | `{ transactionId, ref, status: 'PENDING' }` |
| pay 200 → `{ transactionId, status }` | `{ transactionId, ref, status: 'PROCESSING' }` — and `ref` is the *discovery* ref |
| `transactionId` like `txn_9f3a…` | a 24-character lowercase hex string |
| `ref` optional on discover | required |
| terminal errors include `NO_BILLS_FOUND` | never emitted |
| list accepts a `ref` filter | accepted then ignored — use `getByRef` |

Two further items found while building this SDK, neither previously documented:

- **`list()` never returns `bills`.** The server projects them away, so a `READY`
  transaction lists as `bills: []` however many bills it holds. Use `get()` before
  acting on bills. The same projection drops `error_details`, so `error` on a listed
  failure is unreliable too.
- **The pay-ref uniqueness rule is enforced in production but not in sandbox.** See
  the `ref` section above.

---

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test              # unit — injected fetch, no network
npm run build
npm run test:integration   # needs the local stack on :3100
```

The integration suite skips with a message when the stack is not running; it never
fails the build for that, and it is never pointed at production.

## License

MIT
