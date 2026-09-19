/**
 * Idempotency ref generation.
 *
 * A `ref` is required on both discover and pay, is capped at 100 characters, and must be
 * unique **per partner** among transactions that are not `FAILED` or refunded. A clash
 * answers `403 DUPLICATED_REF`.
 *
 * Per partner, not per account: the same string sent twice for one biller collides even
 * when the two calls name different customers, which is what makes a ref keyed off a
 * batch — `monthly-ade-2026-09` — fail on the second customer of the run. The same
 * string is free to reappear under a different biller, which is why `getByRef` takes a
 * `partner` to disambiguate.
 *
 * Nothing here may import `node:crypto`. The SDK is imported directly by browser apps,
 * and a bare `node:` specifier anywhere in the module graph is a bundler error before
 * it is ever a runtime one — the Vue app simply fails to build. Web Crypto is reachable
 * under the same name in Node 18+, Deno, Bun, workers and browsers, so the SDK asks
 * `globalThis` and adapts to what it finds.
 */

/** The API's hard limit on `ref` length. */
export const REF_MAX_LENGTH = 100;

/**
 * The slice of Web Crypto this module uses, described structurally so the lookup
 * type-checks on a runtime that has neither DOM nor Node globals declared.
 */
interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** Read at call time, never at import time, so a test can substitute one. */
const webCrypto = (): CryptoLike | undefined =>
  (globalThis as unknown as { crypto?: CryptoLike }).crypto;

const hex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

/** Stamp the RFC 4122 version (4) and variant bits, then format the canonical 8-4-4-4-12. */
const formatUuidV4 = (bytes: Uint8Array): string => {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * A v4 UUID from whatever source of randomness the host offers.
 *
 * Three paths, in descending order of preference:
 *
 * 1. `crypto.randomUUID()` — every modern runtime, and the only one that is a single
 *    call.
 * 2. `crypto.getRandomValues()` — the one that matters in practice for browsers.
 *    `randomUUID` is restricted to secure contexts, so a Vue app served over plain
 *    `http://` on a LAN address has `crypto` but no `randomUUID`; `getRandomValues` is
 *    still there.
 * 3. `Math.random()` — not cryptographically random, and reached only on a host with no
 *    Web Crypto at all. A ref has to be *unique*, not unguessable: it is an idempotency
 *    key the caller usually chooses themselves, it is never a secret, and it grants
 *    nothing. So a weak source degrades the collision odds, which the API reports
 *    plainly as `DUPLICATED_REF`, rather than exposing anything.
 */
const randomUuid = (): string => {
  const c = webCrypto();

  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return formatUuidV4(bytes);
};

/**
 * Generate a unique ref, optionally namespaced by a prefix of your own.
 *
 * The result is `<prefix>-<uuid>` and is always within the 100-character limit: an
 * over-long prefix is truncated rather than allowed to produce a ref the API would
 * reject. The UUID is never truncated, so uniqueness survives truncation.
 *
 * ```ts
 * newRef();                 // '3f7c1e58-...'
 * newRef('order-12345');    // 'order-12345-3f7c1e58-...'
 * ```
 */
export const newRef = (prefix?: string): string => {
  const uuid = randomUuid();
  if (!prefix) return uuid;

  const clean = prefix.trim().replace(/\s+/g, '-');
  if (!clean) return uuid;

  const room = REF_MAX_LENGTH - uuid.length - 1;
  if (room <= 0) return uuid;
  return `${clean.slice(0, room)}-${uuid}`;
};

/**
 * Derive the pay ref that belongs with a discovery ref.
 *
 * Giving the payment its own ref is the convention the docs ask for, and it is worth
 * keeping: it makes your own logs unambiguous about which call you are looking at, and
 * it survives the day the server starts enforcing the rule. It is not, today, a hard
 * requirement — the live deployment accepts the discovery ref on a pay and answers
 * `200 PROCESSING`, whatever the published `403 DUPLICATED_REF` says.
 *
 * This appends a short marker and a fresh UUID segment, trimming the discovery ref if
 * needed to stay within the limit.
 *
 * Remember that the pay ref is validated and then discarded: the transaction keeps its
 * discovery ref, so look transactions up by the *discovery* ref, never this one.
 */
export const payRefFor = (discoveryRef: string): string => {
  const suffix = `-pay-${randomUuid().slice(0, 8)}`;
  const room = REF_MAX_LENGTH - suffix.length;
  return `${discoveryRef.slice(0, Math.max(0, room))}${suffix}`;
};

/** Whether a ref is acceptable to the API: non-empty after trimming, ≤ 100 chars. */
export const isValidRef = (ref: string): boolean => {
  const t = ref.trim();
  return t.length > 0 && t.length <= REF_MAX_LENGTH;
};
