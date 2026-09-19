# Changelog

All notable changes to `@terminaldz/billpay-sdk`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-09-19

Two of the fixes below are the reason this release exists: the SDK had the wrong host and
the wrong partners path, so **no previous version could reach the API at all**. Every
call from 0.1.0 and 0.2.0 answered `401 INVALID_ACCESS_TOKEN`, whatever the key. The
contract changes came out of verifying the rest of the surface live once the requests
started landing.

### Fixed

- **The default `fetch` is bound to `globalThis`.** The transport calls it as a method on
  its own config object, so an unbound `globalThis.fetch` arrived with the wrong `this`.
  Node's `fetch` does not care; a browser throws `TypeError: Failed to execute 'fetch' on
  'Window': Illegal invocation`, which turned **every** call from a page into a
  `BillPayNetworkError` carrying nothing that pointed at the cause. Invisible to a suite
  that only runs in Node, so the regression test installs a `this`-sensitive `fetch` and
  holds the SDK to the browser's contract.
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
