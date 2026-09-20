/**
 * Idempotency refs.
 *
 * A `ref` is required on discover and pay, is at most 100 characters, and must be unique
 * per partner among your live transactions; a clash answers `403 DUPLICATED_REF`.
 * Uses Web Crypto from `globalThis` (no `node:` imports) so the same build runs in browsers.
 */

/** The API's hard limit on `ref` length. */
export const REF_MAX_LENGTH = 100;

/** The slice of Web Crypto this module uses, described structurally. */
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
 * A v4 UUID: `crypto.randomUUID()`, then `crypto.getRandomValues()` (insecure contexts),
 * then `Math.random()` on a host with no Web Crypto. A ref must be unique, not secret.
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
 * A unique ref, `<prefix>-<uuid>`, always within the 100-character limit (the prefix is
 * truncated, never the UUID).
 *
 * ```ts
 * newRef('order-12345'); // 'order-12345-3f7c1e58-...'
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
 * The pay ref for a discovery ref: `<discoveryRef>-pay-<8 hex>`, trimmed to the limit.
 * `pay` requires a ref distinct from the discovery ref (`403 DUPLICATED_REF` otherwise);
 * the transaction keeps the discovery ref, so look it up by that one.
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
