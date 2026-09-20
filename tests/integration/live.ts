/**
 * Shared plumbing for the live integration suite.
 *
 * These tests talk to the **real sandbox**, at the same host production uses — the key
 * is the only thing that tells the two apart. That is the whole value of the suite: the
 * sandbox scenario matrix is deterministic, the account identifier chooses the outcome,
 * and so a decline, a refund and an unconfirmed payment can be produced on demand and
 * asserted against the deployment rather than against a local double that agrees with
 * the SDK by construction.
 *
 * Nothing here moves money, and the first thing this module does is prove it: it reads
 * `apiKey.type`, and if the answer is anything but `SANDBOX` every test is skipped
 * before a single discovery is started. The other stop condition is simpler — no
 * network, no suite, no failed build.
 *
 * The module settles all of that at import time, with a top-level `await`, so that by
 * the time the test file is collected `live` and {@link available} are plain booleans
 * that `describe.skipIf` can read. A suite that skips says so in the reporter, which is
 * worth more than a suite that passes vacuously.
 */

import {
  BillPayClient,
  BillPayRateLimitError,
  newRef,
  PARTNERS,
  type AccountIdentifier,
  type BillPayClientOptions,
  type DiscoverAck,
  type Partner,
  type PartnersMap,
  type Transaction,
  type ValidateResult,
} from '../../src/index.js';

/**
 * The host that serves both environments. Overridable only so an operator can point the
 * suite at a staging mirror; there is no separate sandbox URL to switch to.
 */
export const BASE_URL = process.env.BILLPAY_BASE_URL ?? 'https://api.oneclickdz.com';

/** The sandbox key from `BILLPAY_SANDBOX_KEY`. Without it the suite skips; a non-sandbox key is refused below. */
export const SANDBOX_KEY = process.env.BILLPAY_SANDBOX_KEY ?? '';

/**
 * Opt-in flag for the one scenario that spends a lockout attempt.
 *
 * The API counts consecutive bad keys and locks out after twenty, so the invalid-key
 * path is worth asserting exactly once, on purpose, and never on every run.
 */
const EXERCISE_BAD_KEY = process.env.BILLPAY_TEST_BAD_KEY === '1';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A client on the sandbox key. Pass overrides to vary a single option. */
export const client = (overrides: Partial<BillPayClientOptions> = {}): BillPayClient =>
  new BillPayClient({ apiKey: SANDBOX_KEY, baseUrl: BASE_URL, timeoutMs: 20_000, ...overrides });

/**
 * A token minted once per process and stamped into every `ref` the suite sends.
 *
 * A ref is unique per partner for as long as a transaction is live — the account is not
 * part of the key — so a literal ref anywhere in this file would pass on the first run
 * and answer `403 DUPLICATED_REF` on the second. The token also makes a run greppable in the
 * partner's own transaction history, which is what you want at 2am when a suite leaves
 * something behind.
 */
export const RUN = `${Date.now().toString(36)}-${newRef().slice(0, 8)}`;

/**
 * A fresh ref for one scenario: run token, a readable label, and a UUID from
 * {@link newRef} that makes it unique even against itself.
 *
 * `newRef` trims an over-long prefix rather than returning something the API would
 * reject, so a verbose label costs readability in the dashboard and nothing else.
 */
export const mintRef = (label: string): string => newRef(`it-${RUN}-${label}`);

/**
 * Retry once through a rate limit, honouring `Retry-After`.
 *
 * The transport already does this for GETs; POSTs it deliberately never retries,
 * because a discover or a pay that may have landed must be recovered by looking it up,
 * not resent. A `429` is the one exception that is safe to resend as-is: it is refused
 * at the edge, before the controller, so nothing was created and the `ref` is still
 * free. This exists because the suite shares one key's budget with whatever else is
 * pointed at that key, not because the SDK needs it.
 */
export const withRateLimitRetry = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (err) {
    if (!(err instanceof BillPayRateLimitError)) throw err;
    const waitMs = (err.retryAfter ?? 5) * 1000;
    console.warn(`[integration] rate limited — holding ${waitMs}ms, then one retry.`);
    await sleep(waitMs);
    return call();
  }
};

// ─── The import-time probe ────────────────────────────────────────────────────

let identity: ValidateResult | null = null;
let partnerMap: PartnersMap | null = null;
let blocked: string | null = null;

/** The failure in one clause, with its full stop dropped so it can be quoted mid-sentence. */
const describeFailure = (err: unknown): string =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\.$/, '');

if (!SANDBOX_KEY) {
  blocked = 'BILLPAY_SANDBOX_KEY is not set';
} else {
  try {
    // `retries: 0`: a refused key must cost exactly one attempt against the lockout counter.
    identity = await client({ retries: 0, timeoutMs: 10_000 }).validate();
  } catch (err) {
    blocked = `the API at ${BASE_URL} did not answer — ${describeFailure(err)}`;
  }
}

if (identity && identity.apiKey.type !== 'SANDBOX') {
  blocked =
    `the configured key is a ${identity.apiKey.type} key. This suite discovers and pays; ` +
    `it will not do that against real money`;
  identity = null;
}

if (!blocked) {
  try {
    partnerMap = await client({ retries: 0 }).partners();
  } catch (err) {
    blocked = `the partner map could not be read — ${describeFailure(err)}`;
  }
}

/** Whether the live suite may run at all. `describe.skipIf(!live)` reads this. */
export const live = blocked === null;

/** The identity behind the key, once the probe has confirmed it is a sandbox one. */
export const sandboxIdentity = identity;

/**
 * Whether the operator has this biller switched on **right now**.
 *
 * Availability is an operator setting, not a contract, and it changes in both
 * environments without an SDK release. So no test asserts a partner is `ACTIVE` or
 * `UNAVAILABLE`; a scenario whose biller is switched off skips, and the reason is
 * printed below rather than hidden in a failure.
 */
export const available = (partner: Partner): boolean => partnerMap?.[partner]?.status === 'ACTIVE';

/** Whether the opt-in invalid-key scenario should run this time. */
export const exerciseBadKey = EXERCISE_BAD_KEY;

if (blocked) {
  console.warn(
    `\n[integration] SKIPPED — ${blocked}.\n` +
      `[integration] This suite runs against the live sandbox API at ${BASE_URL}.\n` +
      `[integration] Set BILLPAY_SANDBOX_KEY to a sandbox key and re-run with a working\n` +
      `[integration] network connection.\n`,
  );
} else {
  console.info(
    `\n[integration] LIVE against ${BASE_URL} as ${identity?.username ?? 'unknown'} ` +
      `(${identity?.apiKey.type ?? '?'}, scope ${identity?.apiKey.scope ?? '?'}).\n` +
      `[integration] Every ref this run carries the token ${RUN}.`,
  );
  for (const partner of PARTNERS) {
    if (available(partner)) continue;
    const status = partnerMap?.[partner]?.status ?? 'absent from the live map';
    console.info(
      `[integration] SKIPPING the ${partner} scenarios — the operator reports ${partner} ` +
        `as ${status}. This is an availability setting, not a failure.`,
    );
  }
  if (!EXERCISE_BAD_KEY) {
    console.info(
      `[integration] SKIPPING the invalid-key scenario — it spends one of twenty attempts ` +
        `before a lockout. Set BILLPAY_TEST_BAD_KEY=1 to run it once.`,
    );
  }
}

// ─── Scenario helpers ─────────────────────────────────────────────────────────

/** What {@link discoverReady} hands back: the acknowledgement, the settled transaction, and the ref. */
export interface Discovery {
  ack: DiscoverAck;
  txn: Transaction;
  ref: string;
}

/**
 * Run one discovery to completion and return everything a scenario wants to assert on.
 *
 * The ref is minted here so no caller can hard-code one, and it is returned because the
 * discovery ref — never the pay ref — is the handle the transaction keeps.
 */
export const discoverReady = async (
  partner: Partner,
  account: AccountIdentifier,
  label: string,
): Promise<Discovery> => {
  const c = client();
  const ref = mintRef(label);
  const ack = await withRateLimitRetry(() => c.bills.discover({ partner, account, ref }));
  const txn = await c.bills.waitForReady(ack.transactionId, { timeoutMs: 45_000 });
  return { ack, txn, ref };
};
