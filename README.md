# @terminaldz/billpay-sdk

The official Node.js/TypeScript SDK for the **OneClickDz Bill Payment API** (`/v3`).

Pay Algerian utility and telecom bills — ADE, SONELGAZ, SEAAL, AADL and Algérie
Télécom — through one API: discover what an account owes, pay one of the discovered
bills, wait for the outcome, download the receipt.

Zero runtime dependencies, and no `node:` imports anywhere in the module graph, so the
same build serves Node 18+ and the browser. Ships CommonJS, ESM and type declarations.

Full API reference: <https://docs.oneclickdz.com>

---

## Install

```bash
npm install @terminaldz/billpay-sdk
```

<details>
<summary>Installing from GitHub Packages instead</summary>

The same version is mirrored to GitHub Packages. To install from there, point the
scope at GitHub in an `.npmrc` beside your `package.json`:

```ini
@terminaldz:registry=https://npm.pkg.github.com
```

GitHub Packages requires authentication even for public packages, so you will also
need a personal access token with `read:packages`:

```ini
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

The npm registry needs none of this. Prefer it unless your organisation standardises
on GitHub Packages.

</details>

## Quickstart

```ts
import { BillPayClient } from '@terminaldz/billpay-sdk';

const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });
const { apiKey } = await client.validate();
console.log(apiKey.type); // 'SANDBOX' | 'PRODUCTION'
```

There is nothing to configure. `https://api.oneclickdz.com` serves **both** environments
and the key decides which one you are talking to, so there is nothing to switch when you
go live and nothing to mis-switch. `baseUrl` exists for a local stack or a recording
proxy, not for choosing an environment.

### What `validate()` returns

```ts
const { username, apiKey } = await client.validate();
// username → '+213558601124'  — the account the key belongs to
// apiKey   → { key, isEnabled, type, allowedips, scope }
```

The environment is at **`apiKey.type`** — one level deeper than it reads, and next to an
`apiKey.key` _string_ that is the key itself, not its kind. `client.environment()` and
the exported `environmentOf(result)` spare you the distinction. Whichever you use, that
field is the only trustworthy answer to "am I about to move real money?", because the URL
is the same either way.

Do not log the result wholesale: `apiKey.key` is the credential.

`GET /v3/validate` is also the one response in the API that carries **no `meta`**, which
is why `SuccessEnvelope.meta` is optional throughout. Code that reaches into `meta`
unconditionally throws a `TypeError` on exactly this response.

---

## The one thing to understand first

**This API is asynchronous.** A `200` from `discover` or `pay` is an _acknowledgement_
that the work started — never an outcome. Discover returns `PENDING`; pay returns
`PROCESSING`. You find out what actually happened by polling.

Everything else in this SDK follows from that.

## The full flow

```ts
import { writeFile } from 'node:fs/promises';
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
if (!discovered.bills?.length) process.exit(0); // nothing payable

// 3. Pay one bill. Give the payment a ref of its own.
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

### Runnable examples

All three run against the real API with a sandbox key, which is what keeps them harmless:
no portal is touched and no money moves. Each refuses to start unless `validate()` says
`SANDBOX`. Build first — they import the package by name, exactly as your own code would,
and so resolve through `exports` to `dist/`.

```bash
npm run build
node --env-file=.env --experimental-strip-types examples/pay-a-bill.ts
```

- [`examples/pay-a-bill.ts`](./examples/pay-a-bill.ts) — the flow above, end to end,
  including the `UNKNOWN` branch and what to do in it.
- [`examples/aadl-avis.ts`](./examples/aadl-avis.ts) — AADL by `codeloc`: the flat echo,
  the single aggregate avis and its `breakdown`, and why there is no bill to pick.
  `BILLPAY_AADL_CODELOC` selects which sandbox scenario you get.
- [`examples/recover-after-timeout.ts`](./examples/recover-after-timeout.ts) — a client
  with a deliberately impossible deadline, so both POSTs genuinely land and both answers
  are genuinely lost. Recovers each by reading, never by resending.

Copy [`.env.example`](./.env.example) to `.env` for the variables they read. Node loads
none of it by itself — `--env-file` is what does.

---

## Statuses

| Status       | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `PENDING`    | Discovery started, not finished.                           |
| `READY`      | Discovery finished — read `bills`.                         |
| `PROCESSING` | Payment in flight.                                         |
| `UNKNOWN`    | Outcome under review. **Not** a failure, **not** terminal. |
| `SUCCESS`    | Paid. `receiptUrl` and `operationId` are set.              |
| `FAILED`     | Not paid. Read `error`.                                    |
| `REFUNDED`   | Money was taken and returned. Read `error`.                |

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

### A bill may carry a `breakdown`

Some partners publish what makes up a bill's `amount`. Today that is AADL, whose total
is an aggregate — rent plus charges plus late penalties across `unpaidPeriods` periods
— which is why a tenant cannot pay part of it.

```ts
bill.breakdown; // { totalRent, totalCharges, totalPenalties, unpaidPeriods, site, dueDate }
```

Every field is optional and present only when the partner supplies it. Most bills have
no `breakdown` at all; treat a missing one as "not published", never as zeroes.

### Read `fee`, not just `amount`

`total` is `selectedBill.amount + selectedBill.fee`. Sandbox returns `fee: 0`, so
`total === amount` there and an integration that quietly charges `amount` looks correct
right up until production, where it will not be. Read both from the response.

---

## The `ref` rules

`ref` is your idempotency key. It is **required** on both discover and pay, capped at
**100 characters**, and must be unique **per partner**. A clash answers
`403 DUPLICATED_REF`. Refs belonging to `FAILED` or refunded transactions become
reusable.

Per partner, not per account. The same string sent twice for one biller collides even
when the two calls name different customers — so a ref keyed off a batch, like
`monthly-ade-2026-09`, gets `403` on the second customer of every run. Key it off
something that is unique on your side, or let `newRef()` do it. The same string _is_ free
to reappear under a different biller, which is why `getByRef` takes a `partner`.

Two rules matter more than the rest:

**1. Give the payment a ref of its own.** `payRefFor(discoveryRef)` derives one. The
published docs call this mandatory and promise `403 DUPLICATED_REF` if you reuse the
discovery ref; live testing shows the deployment in fact accepts it and answers
`200 PROCESSING`. So treat a distinct pay ref as the convention it is — cheap,
unambiguous in your own logs, and already correct on the day the server starts enforcing
what it documents — rather than as a constraint you have to engineer around.

**2. The pay ref is validated and then discarded.** This one _is_ enforced, and it is
the one that bites. The transaction keeps its **discovery** ref:

```ts
const ack = await client.bills.pay({ transactionId, billId, ref: payRef });
ack.ref === discoveryRef; // ← the DISCOVERY ref, not the one you just sent

await client.bills.getByRef({ ref: discoveryRef }); // ✅ resolves
await client.bills.getByRef({ ref: payRef }); // ❌ 404, always
```

Store the discovery ref. The pay ref is write-only.

### Never blindly retry a POST

`discover` and `pay` create transactions, and reusing a ref is _rejected_ rather than
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

GETs _are_ retried automatically — twice by default, on network failures and timeouts, on
any 5xx and on `429`, honouring `Retry-After` when the server sends one, up to a 30-second
ceiling. The ceiling is there because the header is a number somebody else chooses: the
origin sends `5`, but a rate-limit rule at the edge can name minutes, and a transport that
sleeps through that turns your own deadline into a suggestion. No other 4xx is retried:
those are yours to fix, and retrying them only burns the rate limit.

### A failed poll is not a failed payment

`waitForReady` and `waitForTerminal` ride out transient read failures rather than ending
the wait over one. A 5xx, a `429`, a dropped socket — none of them says anything about the
transaction, so the poller keeps the last status it did see and carries on to its
deadline. Only a refusal that will not change its mind — `404`, `401`, a malformed id —
comes back to you mid-wait.

So the wait ends in exactly two ways: the transaction reached the state you asked for, or
`BillPayPollTimeoutError`. That error now covers the case where the reads themselves were
the problem, with `lastStatus` undefined and the last refusal as `cause`. Both mean the
same thing to your order state — nobody knows yet — so both belong in the branch that
hands the id to background reconciliation, not in one that reports a failure.

`timeoutMs` bounds the whole wait, reads included, so the handoff fires when you said it
would even if a single request hangs.

---

## Errors

Every failure throws a typed error extending `BillPayError`, which carries `code`,
`httpStatus`, `requestId`, `retryAfter` and `details`. The API key never appears in a
message, a property or a stack.

| Class                     | Codes                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `BillPayAuthError`        | `MISSING_ACCESS_TOKEN`, `INVALID_ACCESS_TOKEN`, `ERR_AUTH`, `IP_BLOCKED`, `IP_NOT_ALLOWED`, `API_DISABLED` |
| `BillPayValidationError`  | `ERR_VALIDATION`, `INVALID_ACCOUNT`, `PAYLOAD_TOO_LARGE`                                     |
| `BillPayConflictError`    | `DUPLICATED_REF`, `BILL_ALREADY_PAID`, `PAYMENT_IN_PROGRESS`                                 |
| `BillPayUnavailableError` | `AUTH_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `PARTNER_UNAVAILABLE`                             |
| `BillPayRateLimitError`   | `RATE_LIMIT_EXCEEDED`                                                                        |
| `BillPayNotFoundError`    | `NOT_FOUND`                                                                                  |
| `BillPayInternalError`    | `INTERNAL_ERROR`                                                                             |
| `BillPayTimeoutError`     | request exceeded `timeoutMs`                                                                 |
| `BillPayNetworkError`     | the request never reached the API                                                            |
| `BillPayAbortError`       | your `AbortSignal` fired                                                                     |
| `BillPayPollTimeoutError` | a polling helper gave up; read `lastStatus`                                                  |

**`AUTH_UNAVAILABLE` is not an auth failure.** It means the API could not verify your
key in time. Your key is fine — retry after `retryAfter` seconds. It is deliberately
_not_ a `BillPayAuthError`, so you never rotate a credential that was never the problem.

**The three 403s about your key are `BillPayAuthError`, not `BillPayConflictError`.**
`IP_BLOCKED`, `IP_NOT_ALLOWED` and `API_DISABLED` say something about your key and where
you are calling from — not about the request. None is worth a retry: the first clears
itself after about fifteen minutes, the other two need a change in the dashboard. The
conflict branch would send you to `getByRef` to read "the existing transaction", which is
exactly the wrong move when the gateway has stopped answering your address.

**`SERVICE_UNAVAILABLE` is the trap in `isRetryable`.** It is transient, so the flag is
`true`, but it means the bill service did not answer _in time_, not that nothing
happened: on a pay, the payment may well be running. Read the transaction before you
resend it. `PARTNER_UNAVAILABLE` and `AUTH_UNAVAILABLE` do promise nothing was started.

**`retryAfter` is usually absent.** In practice only `AUTH_UNAVAILABLE` and a rate limit
send `Retry-After`. An absent value means "back off on your own schedule", not "retry
now".

**A transaction belonging to another partner returns `404`, not `403`.** The API does
not confirm that someone else's id exists. The same goes for the other environment: a
sandbox key never sees a production transaction, and the answer is `404` either way.

**Never loop over candidate keys.** The API counts consecutive rejections and locks a key
out after twenty, telling you how many are left in the message. Spend them all and the
next answer is `403 IP_BLOCKED` — your address stops being served for about fifteen
minutes, whatever key you present. Assert the bad-key path once, at most.

Inside a `FAILED` or `REFUNDED` transaction, `error.code` is one of
`PAYMENT_DECLINED`, `PARTNER_UNAVAILABLE`, `INVALID_ACCOUNT`, `BILL_ALREADY_PAID`.

### Refusals that never reached the application

Not every failure carries the house envelope. A path the router does not know answers
`{ message, error, statusCode }` with no `success` field, and a proxy in front of the API
may answer with no JSON at all. The SDK turns both into the same typed errors as
everything else, keeping the server's own sentence as the message — "not found" is what
happened, and "I could not read the body" is not.

Where the status maps to exactly one documented code the SDK uses it (`404` →
`NOT_FOUND`, `413` → `PAYLOAD_TOO_LARGE`, `429` → `RATE_LIMIT_EXCEEDED`, `500` →
`INTERNAL_ERROR`, `503` → `SERVICE_UNAVAILABLE`). Otherwise `code` is `HTTP_<status>`,
which is deliberately not a value the API can send — so you can always tell a code the
server chose from one the SDK inferred on its behalf.

---

## Partners and accounts

| Partner           | Account field       | Format                               |
| ----------------- | ------------------- | ------------------------------------ |
| `ADE`             | `reference`         | up to 50 characters                  |
| `SEAAL`           | `reference`         | up to 50 characters                  |
| `SONELGAZ`        | `contractNumber`    | up to 50 characters                  |
| `AADL`            | `aadl: { codeloc }` | 6–20 digits                          |
| `Algérie Télécom` | `phoneNumber`       | `0`, then a digit 2–4, then 7 digits |

`'Algérie Télécom'` carries its accents — it is the literal value the API matches.

The landline is a local number, `^0[2-4][0-9]{7}$`, and the international spelling of the
same number is refused: `'+21323456789'` answers `400 ERR_VALIDATION`. If your form
normalises phone input to E.164, stop short of this field and send `'023456789'`.

An account carries **exactly one** identifier. The union type makes two a compile-time
error:

```ts
{ reference: '…' }                      // ✅
{ reference: '…', contractNumber: '…' } // ❌ does not compile
```

The nested forms (`sonelgaz{}`, `ade{}`, `aadl{}`) and the snake_case forms
(`electronic_payment_key`, exactly 25 characters; `phone_number`) are also accepted.
Responses echo a single **flat** key — `reference`, `contractNumber`, `codeloc` or
`phoneNumber` — so a nested `ade{}` comes back as `reference` and a nested `aadl{}`
comes back as `codeloc`.

### AADL is `codeloc`, and only `codeloc`

```ts
{
  aadl: {
    codeloc: '1112223334';
  }
} // the only AADL account shape there is
```

`codeloc` is the housing file number: digits only, 6 to 20 of them, always required. It
must travel **inside** the `aadl` object — a flat `account.codeloc`, like the retired
`aadlNumber` shorthand, answers `400 ERR_VALIDATION` with "account must contain exactly
one identifier".

There is no second AADL method. The `billnum`/`amount` pair earlier versions of this SDK
accepted is gone from the contract, and `AadlAccount` no longer compiles with it. The
server's Joi layer strips unknown keys rather than rejecting them, so sending them still
answers `200` — it simply changes nothing. That is leniency, not a contract, and it is
not worth building on.

**A housing file bills one aggregate total, never a list.** There is exactly one open
avis per file at a time, with every unpaid earlier period folded into it —
`breakdown.unpaidPeriods` says how many — and AADL publishes no per-period invoice behind
that total. So a discovery returns one payable entry however far behind the tenant is,
none of it is separately payable, and there is no bill to pick: the multi-bill screen you
built for SONELGAZ will render a list of one, forever. Show the total, and pay it whole.

### Availability is a runtime fact, not a documented one

```ts
const partners = await client.partners(); // GET /v3/bills/partners
// { ADE: { status: 'ACTIVE' }, AADL: { status: 'ACTIVE' }, SEAAL: { status: 'UNAVAILABLE' }, … }
```

This map is the only honest answer to "can I offer this biller today?". Availability
changes in both environments without an SDK release, so build the partner picker from the
map at runtime and render from the result — rather than hard-coding a list, or trusting a
sentence in a document (including this one), or discovering at payment time that a biller
has been switched off and answering `503 PARTNER_UNAVAILABLE` to a customer who has
already typed their reference.

### AADL's _avis de paiement_

```ts
const avis = await client.bills.avis(transactionId); // GET …/transactions/{id}/avis
await writeFile(avis.filename, avis.bytes); // avis_<id>.pdf
```

**The live deployment does not route this endpoint yet.** It is fully documented and
implemented here against that contract, but today the server answers a router-level miss,
which the SDK surfaces as a clean `BillPayNotFoundError` with `code: 'NOT_FOUND'` and
`httpStatus: 404`. Keep the call behind the same `catch` you use for a missing receipt,
and the day it ships your code starts returning a PDF instead.

Three things about it are worth knowing before you wire it up:

- **It is not the receipt.** The receipt proves your payment went through; the avis is
  AADL's own statement of what the housing file owes. `Avis` and `Receipt` are
  deliberately the same TypeScript shape — bytes plus the headers you need to file them —
  so one helper can save either. Store the receipt against your order; hand the avis to
  the tenant.
- **AADL only.** Every other partner answers `404`. Read `partner` on the transaction and
  offer the download only when it is `AADL`.
- **Addressed by transaction, never by housing file.** There is no `codeloc` parameter and
  none is accepted. AADL's own export page answers with a PDF for any code it is given, so
  proxying a caller-supplied one would turn this into a way to enumerate other people's
  files; resolving the file from a transaction you own makes that impossible. If your code
  builds a `codeloc` for this call, it is calling the wrong thing.

Unlike the receipt, the transaction does not have to be `SUCCESS` — any AADL transaction
of yours that has resolved a bill can produce an avis, so a `READY` discovery is enough.
Fetch it fresh each time: AADL regenerates the document every period, which is why the
response says `no-store`.

### Receipts can 404

`receiptUrl` is set on **every** `SUCCESS`, including when the manager holds no bytes
for it. Always handle `BillPayNotFoundError` from `receipt()`; never treat the presence
of a URL as a promise that a file exists.

---

## Browsers

The SDK imports nothing — no dependencies, and no `node:` builtins anywhere in the module
graph — so a bundler can take `@terminaldz/billpay-sdk` straight into a Vue, React or
Svelte app. There is no separate browser build and no `browser` export condition to
resolve, because there is nothing for one to swap out: the ESM entry _is_ the browser
entry. The code is identical; three _response headers_ are not, and
[the next section](#what-a-browser-cannot-see) says which.

Refs come from Web Crypto, looked up on `globalThis` at call time: `crypto.randomUUID()`
where it exists, `crypto.getRandomValues()` otherwise. That second path is not
theoretical — `randomUUID` is restricted to secure contexts, so an app served over plain
`http://` on a LAN address has `crypto` but no `randomUUID`. A host with no Web Crypto at
all falls back to `Math.random()`, which degrades the collision odds and nothing else: a
ref must be unique, not unguessable, and the API reports a collision plainly as
`DUPLICATED_REF`.

The API sends permissive CORS — `access-control-allow-origin: *`, with `x-access-token`
among the allowed headers — so a front-end can call it directly, with no dev proxy.

### What a browser cannot see

CORS is permissive about _making_ the request and silent about _reading_ the response:
the API sends no `Access-Control-Expose-Headers`, so a browser hands the SDK only the
safelisted headers. Three the SDK reads are not on that list, and `Headers.get` returns
`null` for all three however plainly they sit on the wire. Nothing throws, but three
values differ between Node and the browser, and it is worth knowing which:

| Header                | Lost value                         | What happens instead                                            |
| --------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `Content-Disposition` | `Receipt.filename`, `Avis.filename` | The SDK names the file `receipt-<id>.png` / `avis_<id>.pdf`     |
| `X-Request-Id`        | `Receipt.requestId`, hook context   | `null` — errors keep theirs, which come from the body           |
| `Retry-After`         | `BillPayError.retryAfter`           | `undefined`, and the transport uses its own exponential backoff |

`Content-Type` _is_ safelisted, which is why the fallback filename can still carry the
right extension — a file saved without one is a file the operating system will not open.

Consumers need TypeScript 5.7 or newer. `Receipt.bytes` is declared
`Uint8Array<ArrayBuffer>` so that `new Blob([receipt.bytes], { type: receipt.contentType })`
— the only way to show or save a receipt in a browser — typechecks; a bare `Uint8Array`
means `Uint8Array<ArrayBufferLike>` on 5.7+, and that is not a `BlobPart`.

**That convenience is also the warning.** A key shipped to a browser is a key you have
published: it is in the bundle, in the network tab, and in anyone's devtools. That is an
acceptable trade for an internal test console or a demo behind your own login, using a
sandbox key. It is not acceptable for a public site, and it is never acceptable for the
production key — keep that one behind your own server and let the browser talk to you.

---

## Sandbox scenarios

Sandbox keys use the same host, routes, envelope and lifecycle as production, touch no
portal and move no money. The **account identifier selects the outcome**, so every
scenario is deterministic.

| Scenario                  | Partner         | Account                                   | Outcome                                                |
| ------------------------- | --------------- | ----------------------------------------- | ------------------------------------------------------ |
| Happy path                | ADE             | `reference: 0123456789012345678901234`    | `READY`, 1 bill @ 443.39 → `SUCCESS`                   |
| Multi-bill                | SONELGAZ        | `sonelgaz{invoice_number: 9876543210, …}` | `READY`, 2 bills → `SUCCESS`                           |
| Nothing due               | ADE             | `reference: 0123456789012340000000002`    | `READY`, `bills: []`                                   |
| Below the 200 DZD floor   | ADE             | `reference: 0123456789012341111111111`    | `READY`, `bills: []`                                   |
| Declined                  | ADE             | `reference: 0123456789012340000000004`    | `FAILED` / `PAYMENT_DECLINED`                          |
| Refunded                  | ADE             | `reference: 0123456789012340000000005`    | `REFUNDED` / `PAYMENT_DECLINED`                        |
| Under review              | SONELGAZ        | `sonelgaz{invoice_number: 6006006006, …}` | `UNKNOWN` (~60 s) → `REFUNDED`                         |
| Invalid account           | ADE             | `reference: abc0000000000000000000000`    | `400 INVALID_ACCOUNT`                                  |
| Biller unreachable        | ADE             | `reference: 0123456789012345005005005`    | `503 PARTNER_UNAVAILABLE`                              |
| Already paid              | ADE             | `reference: 0123456789012347777777777`    | `409 BILL_ALREADY_PAID`                                |
| Landline                  | Algérie Télécom | `phoneNumber: 023456789`                  | `READY`, 1 bill @ 300.00 → `SUCCESS`                   |
| AADL, payable avis        | AADL            | `aadl{codeloc: 1112223334}`               | `READY`, 1 avis @ 5400.00 with `breakdown` → `SUCCESS` |
| AADL, arrears folded in   | AADL            | `aadl{codeloc: 2223334445}`               | `READY`, 1 avis @ 12000.00, `unpaidPeriods: 2`         |
| AADL, nothing due         | AADL            | `aadl{codeloc: 3334445556}`               | `READY`, `bills: []`                                   |
| AADL, already settled     | AADL            | `aadl{codeloc: 4445556667}`               | `409 BILL_ALREADY_PAID`                                |
| Anything else well-formed | any available   | anything not listed                       | `READY`, 1 bill @ 500.00 → `SUCCESS`                   |

Two practicalities. **Every `ref` must be fresh per run**, or the second run of a suite
fails on `DUPLICATED_REF` — `newRef()` exists for this. And **sandbox returns `fee: 0`**,
so `total === amount` here and only here.

---

## Configuration

```ts
new BillPayClient({
  apiKey: process.env.BILLPAY_API_KEY!,
  baseUrl: 'https://api.oneclickdz.com', // default — serves both environments
  timeoutMs: 15_000, // per request
  retries: 2, // GET only, never POST
  fetch: myFetch, // optional, for tests
  onRequest: ({ method, path }) => {},
  onResponse: ({ method, path, status, requestId, durationMs }) => {},
});
```

Hooks receive method, path, status, `requestId` and duration — never headers, never
your key. Clients hold no global state, so a sandbox client and a production client can
run side by side.

---

## Known drift

The published spec disagrees with the implementation in several places. This SDK
follows the **implementation**, which is what you will actually receive.

| `openapi.yaml` says                                   | The API does                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| list returns `data: { transactions: [...] }`          | `data` is a bare array; counts are in `meta`                                      |
| discover 200 → `{ transactionId, status, createdAt }` | `{ transactionId, ref, status: 'PENDING' }`                                       |
| pay 200 → `{ transactionId, status }`                 | `{ transactionId, ref, status: 'PROCESSING' }` — and `ref` is the _discovery_ ref |
| `transactionId` like `txn_9f3a…`                      | a 24-character lowercase hex string                                               |
| `ref` optional on discover                            | required                                                                          |
| terminal errors include `NO_BILLS_FOUND`              | never emitted                                                                     |
| list accepts a `ref` filter                           | accepted then ignored — use `getByRef`                                            |

And from the published guides and reference, each of these checked live:

- **`list()` never returns `bills`.** The server projects them away, so a `READY`
  transaction lists as `bills: []` however many bills it holds. Use `get()` before acting
  on bills. The same projection drops `error_details`, so `error` on a listed failure is
  unreliable too.
- **`GET …/transactions/{id}/avis` is documented but not deployed.** It answers a
  router-level `404` today. See [AADL's _avis de paiement_](#aadls-avis-de-paiement).
- **The pay-ref rule is softer than documented.** The reference says reusing the discovery
  ref on a pay answers `403 DUPLICATED_REF`; the deployment accepts it and answers
  `200 PROCESSING`. `payRefFor()` keeps you on the documented side either way.
- **The sandbox guide says AADL is switched off.** That note is stale: AADL is `ACTIVE`
  and its scenarios are reachable. `SEAAL` is the partner currently answering
  `503 PARTNER_UNAVAILABLE` for every identifier. Neither statement is one to build on —
  read `client.partners()` at runtime.
- **`fee` is `0` in sandbox.** So `total === amount` there, and an integration that
  charges `amount` will look right until the day it does not.
- **`meta` is not always sent.** `GET /v3/validate` answers with `success` and `data`
  alone, so `SuccessEnvelope.meta` is optional and `list()` falls back to what the page it
  received can prove — a derived `total` is a floor, not the real total.

---

## Development

```bash
npm install
npm run lint
npm run typecheck
npm run format:check  # prettier; `npm run format` writes
npm test              # unit — injected fetch, no network
npm run test:all      # lint, typecheck and unit: every gate that needs no network
npm run build
npm run test:integration   # runs against the live sandbox
```

The integration suite talks to the real sandbox rather than a local double, because the
scenario matrix is deterministic there and a local double would only agree with the SDK by
construction. It refuses to run on a key whose `apiKey.type` is not `SANDBOX`, and it skips
with a message when nothing answers — it never fails the build for an absent network, and
it is never pointed at production.

## License

MIT
