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
- **`ERR_AUTH`, `IP_NOT_ALLOWED` and `API_DISABLED` map to `BillPayAuthError`.** The two
  403s were previously caught by the status fallback and arrived as
  `BillPayConflictError`, which reads as "the work is already done" for what is really
  "this key may not be used from here".
- **GETs are retried on `429`** as well as on 5xx and network failures, honouring
  `Retry-After`. POSTs are still never retried, and no other 4xx is.
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
- Types: `ApiEnvironment` (`'SANDBOX' | 'PRODUCTION'`), `Avis` (deliberately the same shape
  as `Receipt`), `KeyErrorCode`, and `UnenvelopedError` for the router-level body.

### Documentation

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
