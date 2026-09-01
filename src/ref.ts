/**
 * Idempotency ref generation.
 *
 * A `ref` is required on both discover and pay, is capped at 100 characters, and must
 * be unique per (account, partner) among transactions that are not `FAILED` or
 * refunded. A clash answers `403 DUPLICATED_REF`.
 */

import { randomUUID } from 'node:crypto';

/** The API's hard limit on `ref` length. */
export const REF_MAX_LENGTH = 100;

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
  const uuid = randomUUID();
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
 * The pay ref **must differ** from the discovery ref, because the discovery
 * transaction is still live when you pay it and its ref is still taken. This appends a
 * short marker and a fresh UUID segment, trimming the discovery ref if needed to stay
 * within the limit.
 *
 * Remember that the pay ref is validated and then discarded: the transaction keeps its
 * discovery ref, so look transactions up by the *discovery* ref, never this one.
 */
export const payRefFor = (discoveryRef: string): string => {
  const suffix = `-pay-${randomUUID().slice(0, 8)}`;
  const room = REF_MAX_LENGTH - suffix.length;
  return `${discoveryRef.slice(0, Math.max(0, room))}${suffix}`;
};

/** Whether a ref is acceptable to the API: non-empty after trimming, ≤ 100 chars. */
export const isValidRef = (ref: string): boolean => {
  const t = ref.trim();
  return t.length > 0 && t.length <= REF_MAX_LENGTH;
};
