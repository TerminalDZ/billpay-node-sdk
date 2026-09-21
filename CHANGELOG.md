# Changelog

All notable changes to `@terminaldz/billpay-sdk`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.7.1 — 2026-09-21

### Changed

- README: the API still accepts the legacy request identifiers `reference` and
  `phoneNumber` for existing integrations; the SDK types the documented shapes.

## 0.7.0 — 2026-09-20

### Breaking

- **`AadlAccount` is exactly `{ aadl: { codeloc } }`.** The optional `billnum`/`amount`
  pair added in 0.6.0 is removed: AADL is addressed one way, by housing file number.

## 0.6.0 — 2026-09-20

Aligns the SDK with the API's identifier contract and the current sandbox behaviour.

### Breaking

- **`AccountIdentifier` now has five members, one per partner:** `ElectronicPaymentKeyAccount`
  (ADE), `PhoneNumberAccount` (Algérie Télécom, now `phone_number`), `SonelgazAccount`,
  `AadlAccount`, `SeaalAccount`. The camelCase aliases `reference`, `contractNumber` and
  `phoneNumber`, and the nested `ade` object, are removed: the API rejects them with
  `400 ERR_VALIDATION` (`contractNumber` was never usable by SONELGAZ, and no portal
  consumes the nested `ade` shape). `ReferenceAccount`, `ContractNumberAccount`,
  `PhoneNumberSnakeAccount` and `AdeInvoiceAccount` are gone; `SonelgazInvoiceAccount` is
  renamed `SonelgazAccount`.
- **Examples and the integration suite no longer embed a sandbox key.** Set
  `BILLPAY_API_KEY` / `BILLPAY_SANDBOX_KEY`.

### Changed

- `Transaction.selectedBills` is typed: the itemised bills of a multi-bill order.
- Documentation follows the deployment: the pay ref must differ from the discovery ref
  (`403 DUPLICATED_REF`); `list()` rows carry `bills`, `selectedBills` and `error`;
  `avis()` is live in production and answers `NOT_FOUND` in the sandbox; sandbox fees use
  the real per-partner rule; there is no 200 DZD discovery floor.
- JSDoc, README and examples rewritten to state the contract concisely.

## 0.5.0 — 2026-09-20

A SEAAL customer owing five quarters used to pay five times — and be charged the 30 DZD
fee floor five times over, 150.00 in fees on an order that should cost 30.00.
`POST /v3/bills/pay` now takes a `billIds` array beside the single `billId`: the selection
becomes one portal order and one card payment, so the service fee is computed **once, on
the combined total**. That arithmetic is the whole of this release. `billId` is untouched,
on the wire and in the type.

### Added

- **`billIds` on `pay()` — 1 to 50 ids, each max 100 characters, none of them repeated.**
  A repeat is `400 ERR_VALIDATION`, "billIds must not repeat the same bill id". The
  selection settles as one order and is charged one fee on the sum of the chosen bills,
  never the sum of the `fee` each bill carries: three SEAAL factures of 327.00, 512.66 and
  735.15 total 1574.81, whose 0.5 percent is 7.87 — under the 30 DZD floor, so the order
  is charged 30.00 once and debits 1604.81, against 1664.81 for the same three paid one by
  one. It is **all or nothing**: every id has to be on the transaction, applied in a single
  atomic transition that requires all of them, so one stale or forged id fails the whole
  payment rather than quietly settling the subset that was still good. The already-paid and
  payment-in-progress guards run for every id, and each reads both the aggregate and the
  itemised lines of earlier payments, so a facture settled before as one line of a group is
  still recognised as paid.
- **`SingleBillPayParams` and `MultiBillPayParams`, both exported.** `PayParams` is now
  their union, modelled the way `AccountIdentifier` is: each member pins the other key to
  `never`, so naming both selections — or neither — is a compile error rather than a `400`
  met in front of a customer. The API's own gate says the same thing: "Provide exactly one
  of billId or billIds".
- **`pay()` refuses a both-given selection before spending a request.** The types make it
  impossible in TypeScript; this is for the JavaScript caller they never reach. The two
  keys are mutually exclusive upstream, so an SDK that quietly picked one of a
  contradictory pair would settle a selection nobody asked for, with money behind it.
  Nothing else about the selection is checked here — an empty array, a fifty-first id, a
  repeated one are each refused by the API in a sentence that names the rule, and a limit
  copied into the SDK is a limit that goes stale the day the server relaxes it.

### Changed

- **`PayParams` is a type alias union, not an interface.** Every existing
  `{ transactionId, billId, ref }` call site compiles unchanged and serialises byte for
  byte as it did — a regression test pins the exact JSON, because a body assembled by
  spreading one branch of a union is exactly the kind of thing that grows a stray
  `billIds: undefined`. The one source-level consequence is that a union cannot be
  `extends`ed or declaration-merged: `interface Mine extends PayParams` no longer compiles.
  Intersect it instead.

### Documentation

- **`Transaction.selectedBill` is the aggregate after a `billIds` payment**, not one of
  the factures: `amount` is the sum, `fee` is the single fee on that sum, and `billId` is
  the **first** id you sent. `total` is therefore the whole order. `Bill` carries no count
  of what went into it, so keep your own list of what you selected.
- **`Bill.fee` does not add up across a selection.** It is what that bill costs to settle
  on its own; summing it over a picker's checkboxes overstates the charge wherever a floor
  is in play, which for SEAAL is everywhere.
- **Multi-bill is no longer described as out of reach.** 0.4.0 said settling several
  factures as one order was a B2C capability "not reachable from here", and the README
  told a reader not to quote the fee-once-on-the-total figure for a `/v3` order. Both are
  withdrawn: it is on this surface now, and the README has a section on it. Also withdrawn
  is the advice that followed from it — a SEAAL customer no longer settles one facture per
  day around the 24-hour double-pay guard; the arrears list goes as one order.
- **The SEAAL fee rule printed in 0.4.0 was wrong.** It is 0.5 percent floored at 30 DZD
  and capped at 60 DZD — `fee = min(60, max(30, total × 0.5 / 100))`, computed on the
  selected total — not 2.5 percent floored at 10 and capped at 50. A few hundred dinars
  never clears the floor, so a SEAAL order under 6000.00 is charged exactly 30.00 however
  many factures it carries. The order minimum was wrong with it: **200 DZD**, and on the
  selected **total**, so two factures each under it can still be payable together. The
  numbers matter more than they did when every payment was one bill — they are what tells
  a reseller whether to quote 30.00 or 90.00 — which is why the correction travels with
  this release rather than waiting for a documentation one.
- **Sandbox mirrors the production arithmetic.** A `billIds` order is assembled there the
  same way: same aggregate, one fee on the selected total, `selectedBill.billId` the first
  id sent. Only the fee's own value differs, and it differs for single bills too —
  sandbox still answers `fee: 0`.
- **The sandbox row labelled "Multi-bill" is now "Two bills discovered".** It is a SONELGAZ
  discovery that returns two payable bills, which is not the same claim as a portal that
  accepts two documents in one transaction. Today that is SEAAL, and the scope note says so
  on the type: elsewhere `billIds` with one entry is `billId` spelled longer.

## 0.4.0 — 2026-09-20

> Not published to npm on its own. These changes reached the registry as part of 0.5.0,
> which is the first release to carry them.

SEAAL is live, and this SDK described it twice over as something it is not: unreachable,
and addressed by a `reference`. Neither was true. The partner is integrated, `ACTIVE`
alongside ADE, AADL and SONELGAZ, and has settled a real payment in production — and its
account identifier is a nested **pair**, not a key. This release adds the shape SEAAL
actually takes and corrects everything that said otherwise.

### Added

- **`SeaalAccount` — `{ seaal: { code_client, code_contrat } }`.** Both halves are
  required, because the portal authenticates on the pair rather than on either half:
  `code_client` is 2 to 6 alphanumeric characters (`^[A-Za-z0-9]{2,6}$`), `code_contrat`
  is 2 to 10 digits (`^\d{2,10}$`), and both are printed on the customer's paper water
  bill. `'seaal'` joins the `AccountKey` union with it, which is what pins
  `seaal?: never` on every other member of `AccountIdentifier`; without that, an object
  carrying `seaal` beside a second identifier would have type-checked and then been
  refused on the wire, which is precisely the mistake the union exists to prevent. There
  is no flat SEAAL shorthand to fall back to — SEAAL has no single key that identifies an
  account.

### Documentation

- **SEAAL does not use `reference`.** `ReferenceAccount`'s TSDoc read "ADE and SEAAL" and
  the README's partner table gave SEAAL a `reference` of up to 50 characters. Both
  described an identifier the portal has never accepted, so a caller who believed either
  had no way to reach the partner at all. `ReferenceAccount` is ADE's and only ADE's, and
  `ElectronicPaymentKeyAccount`'s exactly-25-character key is not a SEAAL shorthand
  either.
- **SEAAL echoes back flat as `codeClient`, not `reference`.** The echo keys by partner
  are `reference` (ADE), `contractNumber` (SONELGAZ), `codeloc` (AADL), `phoneNumber`
  (Algérie Télécom) and `codeClient` (SEAAL) — so a nested `seaal{}` comes back as
  `codeClient`, mirroring how `aadl{}` comes back as `codeloc`.
- **The identifier gate is quoted as it now reads.** A request with zero or two
  identifiers answers "Exactly one of electronic_payment_key, phone_number, sonelgaz,
  ade, aadl, or seaal is required". The README quoted an older sentence in the AADL
  section, which is also the one place a reader looks for what a mis-nested identifier
  does.
- **0.3.0's claim that SEAAL was unavailable is withdrawn.** That release note and the
  README both named `SEAAL` as the partner answering `503 PARTNER_UNAVAILABLE` for every
  identifier. It answers in about 194 ms with `status: 'ACTIVE'`. The advice around the
  claim stands, and is the reason printing the claim was a mistake in the first place:
  availability is a runtime fact — read `client.partners()`.
- **SEAAL is the first partner that genuinely needs a bill picker.** A water account is
  billed quarterly and commonly owes several quarters at once; one account verified in
  production had 45 outstanding. The README's AADL section used to name SONELGAZ as the
  partner a multi-bill screen was built for; it now names SEAAL, and AADL is unchanged as
  the one-aggregate-avis partner it has always been.
- **Multi-bill settlement is a B2C capability, and is documented as one.** The B2C route
  accepts either a single `bill_id` or an array of `bill_ids`, settles the selection as
  one portal order and one card payment, and charges the fee **once on the total**. `/v3`
  — the surface this SDK speaks — still pays a single `billId`, so `pay()` is unchanged
  and that arithmetic does not apply to it. Said plainly in the README, because quoting a
  B2C total for a `/v3` order would misprice every bill a reseller shows.
- **SEAAL's fee rule.** 2.5 percent, floored at 10 DZD and capped at 50 DZD:
  `fee = min(50, max(10, amount × 2.5 / 100))`. The platform publishes it on its status
  route as `fee_rule` (`{ percent, min, max }`); the SDK does not model that field, so
  read the `fee` the transaction reports rather than recomputing one.
- **The three SEAAL refusals an integrator will meet.** A 100 DA minimum order ("Le
  montant total sélectionné doit être au moins de 100 DA", raised as a `500`); a
  temporary per-account lockout ("Compte temporairement bloqué. Réessayez dans
  4 heure(s)."), which is `UPSTREAM_UNAVAILABLE` internally but reaches `/v3` as
  `PARTNER_UNAVAILABLE` — a `503`, or a `FAILED` discovery's `error.code` — and so is
  indistinguishable here from a real portal outage, which is why the advice is "try later"
  rather than "check your codes"; and "Vous êtes à jour, merci pour votre fidélité.",
  which at discovery is `READY` with an empty `bills` array, not a failure.
  Also documented: the portal answers "Veuillez vérifier vos informations." to a bad
  captcha and to bad credentials alike, so the platform retries before blaming the
  account, and reconciliation is by absence — a paid facture stops being returned in the
  unpaid list.
- **A SEAAL `billId` _is_ the invoice number** (`numero_fac`, e.g. `F059107046`), so
  there is no lookup between discovery and payment, and `period` reads as the customer's
  quarter (`'1er trimestre 2026'`). The receipt carries SEAAL's own "Numéro d'opération
  SEAAL" beside SATIM's "Numéro de transaction" and "Numéro d'autorisation".
- **The sandbox SEAAL scenarios are listed.** `100001` five unpaid quarters — the
  signature multi-bill shape — `100002` a single facture, `100003` a settled account,
  `100004` a decline at payment, `100005` a pair the portal rejects with
  `400 INVALID_ACCOUNT`. They key off `code_client`, and the pair is still required.

## 0.3.0 — 2026-09-19

Two of the fixes below are the reason this release exists: the SDK had the wrong host and
the wrong partners path, so **no previous version could reach the API at all**. Every
call from 0.1.0 and 0.2.0 answered `401 INVALID_ACCESS_TOKEN`, whatever the key. The
contract changes came out of verifying the rest of the surface live once the requests
started landing.

### Fixed

- **The default `fetch` is bound to `globalThis`.** The transport calls it as a method on
  its own config object, so an unbound `globalThis.fetch` arrived with the wrong `this`.
  Node's `fetch` does not care. A browser throws an `Illegal invocation` `TypeError`, so
  **every** call from a page became a `BillPayNetworkError` carrying nothing that pointed
  at the cause. This release dropped `node:crypto` precisely so a browser could import the
  SDK; this would have stopped it working the moment one did. Invisible to a suite that
  only runs in Node, so the regression test installs a `this`-sensitive `fetch` and holds
  the SDK to the browser's contract.
- **`DEFAULT_BASE_URL` is now `https://api.oneclickdz.com`** (was
  `https://billapi.oneclickdz.com`). The old host rejects every key with
  `401 INVALID_ACCESS_TOKEN`; it was never a valid default. One host serves both
  environments — the key decides which one you are in, so there is nothing to switch when
  you go live.
- **`partners()` now calls `GET /v3/bills/partners`** (was `GET /v3/partners`, a `404`).
  The partner map has never been readable through this SDK until now.
- **`SuccessEnvelope.meta` and `.requestId`, and `ErrorEnvelope.requestId`, are optional.**
  `GET /v3/validate` answers with `success` and `data` alone, so `list()`'s unconditional
  `envelope.meta.total` threw a `TypeError` on exactly that response. `list()` now reads
  `meta` defensively and falls back to what the page it received can prove.
- **`Transport.requestRaw()` throws on every status ≥ 400**, including bodies that are not
  the house envelope and bodies that are not JSON at all. A `404` on `receipt()` used to be
  handed back as a `Uint8Array` a caller would happily write to disk as a PDF.
- **Refusals that never reached the application are typed like any other.** A path the
  router does not know answers `{ message, error, statusCode }` with no `success` field;
  the transport now maps those by HTTP status, keeps the server's own sentence as the
  message, and uses the canonical code where the status has exactly one (`404` →
  `NOT_FOUND`, `413`, `429`, `500`, `503`) or `HTTP_<status>` — a value the API can never
  send — where it does not.
- **`ERR_AUTH`, `IP_BLOCKED`, `IP_NOT_ALLOWED` and `API_DISABLED` map to
  `BillPayAuthError`.** The three 403s were previously caught by the status fallback and
  arrived as `BillPayConflictError`, which reads as "the work is already done" for what is
  really "this key may not be used from here". `IP_BLOCKED` is the far end of the
  twenty-attempt lockout, and the conflict branch's own advice — look the existing
  transaction up with `getByRef` — is the one thing that cannot help when the gateway has
  stopped answering your address.
- **GETs are retried on `429`** as well as on 5xx and network failures, honouring
  `Retry-After` up to a 30-second ceiling. The header is a number somebody else chooses:
  uncapped, a single read could sleep for as long as it named, so a two-minute poll
  meeting `Retry-After: 3600` spent an hour inside one request with the transaction
  unwatched. POSTs are still never retried, and no other 4xx is.
- **A failed poll no longer ends the wait.** `waitForReady` and `waitForTerminal` called
  `get()` with no `catch`, so any transport error that survived the GET retries — a 5xx, a
  `429`, a dropped socket — rejected the whole helper. Since `waitForTerminal` is only
  reached after `pay` returned `PROCESSING`, roughly a second of upstream noise abandoned
  a payment that was still in flight, with an error carrying neither `transactionId` nor
  `lastStatus`. The pollers now ride transient failures out to the deadline and give up as
  `BillPayPollTimeoutError`, which gained a `cause` for the last refusal; a refusal that
  polling cannot fix (`404`, `401`, a malformed id) is still thrown straight through.
- **`PollOptions.timeoutMs` bounds the reads too.** The deadline was only checked between
  requests, so one hanging read or a long `Retry-After` could overrun the caller's budget
  without limit and the handoff to background reconciliation fired late or not at all. The
  deadline is now carried into every request as a signal, and it is still reported as
  `BillPayPollTimeoutError` rather than as an abort — an abort is the caller's own
  decision and means something different.
- **`exports` gives each condition its own `types`.** The map was flat, so the ESM
  `index.d.ts` was selected for `require` as well; because the package is `type: module`,
  TypeScript then refused to let a CommonJS file import it (`TS1479` under
  `module: node16`/`node18`) even though `dist/index.cjs` and a matching `index.d.cts`
  were both being published. Runtime resolution was never affected, which is why nothing
  noticed. Verified against CJS, ESM and bundler consumers.
- **A blank `baseUrl` means "use the default".** `BILLPAY_BASE_URL=` is how a `.env` file
  says it, and it reaches the constructor as the empty string, which `??` took literally:
  every request then failed on `new URL('')` with a bare `TypeError: Invalid URL`, thrown
  from a line the caller never wrote and carrying no `code`. Blank and whitespace now fall
  back to `DEFAULT_BASE_URL`, and a `baseUrl` that is not a parseable absolute URL is a
  `BillPayValidationError` at construction rather than a stranger failure on every call.
- **No `node:crypto`.** `src/ref.ts` imported `randomUUID` from it, which is a bundler
  error before it is ever a runtime one — a browser app simply failed to build. Refs now
  come from `globalThis.crypto.randomUUID()`, falling back to `getRandomValues()` (the
  path that matters: `randomUUID` is secure-context-only, so an app served over plain
  `http://` has one and not the other) and, on a host with no Web Crypto at all, to
  `Math.random()`. There is no `node:` specifier left anywhere in the module graph, so the
  ESM build is also the browser build — no separate entry, no `browser` export condition.

### Changed — breaking

- **`AadlAccount` is now exactly `{ aadl: { codeloc: string } }`.** `billnum` and `amount`
  are gone from the contract, and passing either is a compile-time error. There is no
  second AADL method and no DIRECT/LOOKUP distinction any more: `codeloc` is the housing
  file number, digits only, 6 to 20 of them, always required. The live server still
  _tolerates_ extra keys inside `aadl{}` — Joi strips unknowns, so they answer `200` and
  change nothing — but that is leniency, not contract, and the type no longer invites you
  to build on it.

  An AADL housing file bills one aggregate total, never a list: exactly one open avis per
  file, with arrears folded in and counted in `breakdown.unpaidPeriods`. There is no bill
  to pick.

- **`Receipt.bytes` and `Avis.bytes` are `Uint8Array<ArrayBuffer>`, which raises the
  minimum consumer TypeScript to 5.7.** From 5.7 on a bare `Uint8Array` means
  `Uint8Array<ArrayBufferLike>`, which includes `SharedArrayBuffer` and so is not a
  `BlobPart` — making `new Blob([receipt.bytes], { type: receipt.contentType })`, the only
  way to show or save a receipt in a browser, a compile error in the consumer's own source
  where `skipLibCheck` cannot hide it. The narrower type is also the accurate one: the
  bytes come from `response.arrayBuffer()`.

- **`ValidateResult` is now `{ username, apiKey: { key, isEnabled, type, allowedips, scope } }`.**
  The old `{ account: { id, status, currency }, key: { type } }` described a
  response the API has never sent — there is no `data.account` on the wire. The
  environment moves from `key.type` to **`apiKey.type`**; `client.environment()` and
  `environmentOf(result)` are there so you do not have to remember that `apiKey.key` is
  the credential and `apiKey.type` is the kind.

### Added

- **`bills.avis(transactionId)`** — `GET /v3/bills/transactions/{id}/avis`, AADL's own
  _avis de paiement_ as a PDF. Returns the same shape as `receipt()`. Note that the live
  deployment does not route this endpoint yet: today it answers a router-level miss, which
  the SDK surfaces as `BillPayNotFoundError`. It is AADL-only, addressed by transaction and
  never by `codeloc`, and does not require the transaction to be `SUCCESS`.
- **`client.environment()`** — a one-field read of `validate()`, and the only trustworthy
  answer to "am I about to move real money?" now that both environments share a host.
- **`environmentOf(result)`** — the same read as a free function, for a `ValidateResult`
  you already have.
- **`BillPayRateLimitError`** — `429` / `RATE_LIMIT_EXCEEDED`, with `isRetryable === true`.
  Previously a `429` arrived as the base `BillPayError`.
- **`BillPayError.isEndpointMissing`**, and the `enveloped` flag behind it — whether a
  refusal ever reached the application, or was turned away by the router in front of it.
  A `404` from each is identical on the wire (`NOT_FOUND`, status `404`) and they mean
  opposite things: "this deployment has no such path" versus "this transaction has no such
  thing". It exists for `avis()`, which is documented and implemented but not yet routed,
  so a caller can write the branch once today and have it keep working unchanged the day
  the endpoint ships — `isEndpointMissing` simply stops being `true`. It also covers a
  proxy or gateway refusing a call before the API sees it.
- **`PollOptions.onPoll`** — called with every transaction `waitForReady` and
  `waitForTerminal` read, including the one they return. The promise alone can only report
  where a transaction ended up, so a payment that held on `UNKNOWN` for a minute and then
  refunded was indistinguishable from one that refunded outright — and those two want very
  different things said to the customer. A UI can now follow the states without
  reimplementing the backoff, the deadline and the cancellation. Anything the hook throws
  is swallowed, because a bad observer must not abandon a wait with money behind it.
- Types: `ApiEnvironment` (`'SANDBOX' | 'PRODUCTION'`), `Avis` (deliberately the same shape
  as `Receipt`), `KeyErrorCode`, and `UnenvelopedError` for the router-level body.

### Changed

- **`receipt()`'s fallback filename carries an extension**, inferred from `Content-Type`:
  `receipt-<id>.png` rather than `receipt-<id>`. That fallback is not the exotic path it
  looks like — `Content-Disposition` is not CORS-safelisted and the API sends no
  `Access-Control-Expose-Headers`, so in a browser the server's filename is unreadable and
  this is the only name there is. A file saved without an extension is one neither Windows
  nor macOS will open on a double-click. `Content-Type` survives the same filter, and an
  unrecognised type still gets no extension rather than a guess. `avis()` already named
  its fallback `avis_<id>.pdf` and is unchanged.

### Documentation

- **What a browser cannot see.** The README's browser section used to assert parity with
  no caveat. The code really is identical, but three response headers the SDK reads —
  `Content-Disposition`, `X-Request-Id` and `Retry-After` — are not CORS-safelisted and
  the API exposes none, so a browser reads `null` for all three however plainly they sit
  on the wire. `Receipt.filename` falls back, `Receipt.requestId` is `null`, and
  `BillPayError.retryAfter` is `undefined` with the transport's own backoff in its place.
  Verified live with `Origin: http://localhost:5173`. Nothing throws; the table in the
  README says which values differ.
- **The landline format was wrong in the one place it was written precisely.**
  `PhoneNumberAccount`'s TSDoc — which is what an editor shows on hover and what ships in
  `dist/index.d.ts` — gave `^(0|\+213)[2-4][0-9]{7}$`, advertising an international form
  the server refuses. Verified live: `'+21323456789'` answers `400 ERR_VALIDATION`,
  `'023456789'` answers `200`. It now reads `^0[2-4][0-9]{7}$` and says so.
- **`ref` uniqueness is per partner, not per (account, partner).** Three places said
  otherwise, which is strictly weaker than what the server enforces and so reads as
  permission: a ref keyed off a batch rather than a customer is legal under the old
  wording and answers `403 DUPLICATED_REF` on the second customer of every run.
- **`Transaction.completedAt` is not a terminality flag.** It was documented as "ISO
  timestamp once terminal, otherwise `null`", which invites `if (txn.completedAt)` as a
  settled check. The server sets it on `READY` and `UNKNOWN` too, and rewrites it when a
  review resolves; only `PENDING` and `PROCESSING` are reliably `null`. Branch on
  `status`.
- The README's full-flow snippet is runnable. It had a top-level `return` — a
  `SyntaxError` in ESM, `TS1108` under TypeScript — and called `writeFile` without
  importing it. Both fixed, and the block now runs end to end against the sandbox.
- The README no longer claims AADL is unavailable — it is `ACTIVE`, and `SEAAL` is the
  partner currently answering `503 PARTNER_UNAVAILABLE`. More to the point, it no longer
  asserts availability at all: read `client.partners()` at runtime.
- The claim that paying with the discovery ref answers `403 DUPLICATED_REF` is gone. The
  deployment accepts it and answers `200 PROCESSING`. `payRefFor()` stays the recommended
  convention, now described as the convention it is rather than a rule you must engineer
  around.
- Browser support is documented, including the permissive CORS that lets a front-end call
  the API with no proxy, and the plain warning that comes with it: a key shipped to a
  browser is a key you have published.

## 0.2.0 — 2026-09-16

The AADL account shape settled on one form. This is a contract change: a removed field
and an added one.

### Removed

- **`account.aadlNumber` (use `account.aadl.codeloc`).** The flat shorthand is gone from
  the SDK and rejected by the API — sending it answers `400` with
  `account.aadlNumber is not allowed`. AADL now has exactly one identifier, the nested
  `aadl{ codeloc, billnum?, amount? }`: `codeloc` is digits, 6–20 characters, always
  required, and `billnum`/`amount` are all-or-nothing (both = pay a known avis, neither =
  let the partner find what is owed). The `AadlNumberAccount` type is replaced by
  `AadlAccount`.
- AADL is echoed back **flat** as `account.codeloc`, not `aadlNumber`, mirroring how a
  nested `ade{}` comes back as `reference`.

### Added

- **`bill.breakdown`** (partner-supplied component breakdown, present for AADL) — an
  optional `BillBreakdown` explaining what makes up a bill's `amount`:
  `totalRent`, `totalCharges`, `totalPenalties`, `unpaidPeriods`, `site`, `dueDate`.
  Every field is optional and emitted only when the partner publishes it; a missing
  `breakdown` means "not published", not zeroes. Additive — existing code is unaffected.

## 0.1.0 — 2026-09-01

- Initial release: `validate`, `partners`, and the `bills` resource (`discover`, `pay`,
  `list`, `get`, `getByRef`, `receipt`, `waitForReady`, `waitForTerminal`), typed errors,
  ref helpers, and hand-written wire types. Zero runtime dependencies; CommonJS, ESM and
  type declarations.
