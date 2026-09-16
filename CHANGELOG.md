# Changelog

All notable changes to `@terminaldz/billpay-sdk`. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
