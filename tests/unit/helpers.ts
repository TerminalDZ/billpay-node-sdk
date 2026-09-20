/**
 * Shared fake-fetch plumbing for the unit suite.
 *
 * Nothing here touches the network. Every test drives the SDK through an injected
 * `fetch` that replays canned responses, so the suite is deterministic and fast enough
 * to run on every keystroke — and so a broken assertion always means the SDK changed,
 * never that a sandbox was slow.
 */

import type { FetchLike } from '../../src/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  /**
   * `Date.now()` as the call was made. Under `vi.useFakeTimers()` this is the fake
   * clock, which is what makes a backoff schedule assertable to the millisecond
   * instead of merely "fast enough".
   */
  at: number;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
  /** A body that is not JSON — raw download bytes, or a proxy's HTML apology. */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a transport failure. */
  throws?: Error;
  /** Never settle, to let a timeout fire. */
  hang?: boolean;
}

export interface FetchStub {
  fetch: FetchLike;
  calls: RecordedCall[];
}

/**
 * A `fetch` that replays the given responses in order, recording each call.
 * The last response repeats once the list is exhausted.
 */
export const stubFetch = (responses: StubResponse[]): FetchStub => {
  const calls: RecordedCall[] = [];
  let i = 0;

  const fetch: FetchLike = async (url, init) => {
    const spec = responses[Math.min(i, responses.length - 1)] ?? {};
    i++;

    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      at: Date.now(),
    });

    if (spec.throws) throw spec.throws;
    if (spec.hang) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      });
    }

    const headers = new Headers(spec.headers ?? {});
    // `BodyInit` is a DOM lib type and is not available under @types/node, so the
    // two shapes this stub actually produces are spelled out instead.
    let body: Uint8Array | string | null;
    if (spec.bytes) {
      body = spec.bytes;
    } else if (spec.json !== undefined) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      body = JSON.stringify(spec.json);
    } else {
      body = null;
    }

    return new Response(body, { status: spec.status ?? 200, headers });
  };

  return { fetch, calls };
};

/**
 * Start a call now and hold on to however it settles.
 *
 * Under fake timers a call is made in one statement and the clock is wound forward in
 * the next, so a promise that rejects while the test is still advancing has no handler
 * attached yet — Node reports that as an unhandled rejection even though the assertion
 * two lines down was always going to catch it. Attaching the handler at the call site
 * keeps the run quiet without weakening anything.
 */
export const settled = <T>(p: Promise<T>): Promise<T | unknown> => p.catch((e: unknown) => e);

/** A success envelope, with `meta` and `requestId` — the usual shape. */
export const ok = <T>(data: T, meta: Record<string, unknown> = {}): unknown => ({
  success: true,
  data,
  meta: { timestamp: '2026-09-01T00:00:00.000Z', ...meta },
  requestId: 'req_test000000000000000000',
});

/**
 * A success envelope with **no `meta` and no `requestId`** — which is exactly what
 * `GET /v3/validate` sends. Code that reaches into `meta` unconditionally throws a
 * `TypeError` on this body and on no other, so it is worth a helper of its own.
 */
export const okBare = <T>(data: T): unknown => ({ success: true, data });

/** An error envelope. */
export const err = (code: string, message = 'boom', details?: unknown): unknown => ({
  success: false,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
  requestId: 'req_test000000000000000000',
});

/**
 * Fastify's router-level miss: no `success`, no `error.code`, just a status and a
 * sentence. A request that never reaches the application answers with this, and today
 * `GET …/{id}/avis` is the ordinary way to meet it.
 */
export const routerMiss = (path: string): unknown => ({
  message: `Route GET:${path} not found`,
  error: 'Not Found',
  statusCode: 404,
});

/** A valid 24-char lowercase hex transaction id. */
export const TXN_ID = '6a96b2336ff709bcb6efed15';

/** `GET /v3/validate` data, field for field as the live sandbox returns it. */
export const VALIDATE_DATA = {
  username: '+213558601124',
  apiKey: {
    key: 'sk_test',
    isEnabled: true,
    type: 'SANDBOX',
    allowedips: [],
    scope: 'READ-WRITE',
  },
} as const;

/** A transaction body with sensible defaults. */
export const txn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  transactionId: TXN_ID,
  ref: 'ref-1',
  type: 'discovery',
  status: 'PENDING',
  partner: 'ADE',
  account: { reference: '0123456789012345678901234' }, // echoed flat by the API
  currency: 'DZD',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
  ...over,
});

/**
 * A settled AADL discovery, as the sandbox returns it for `codeloc: '1112223334'`:
 * the identifier echoed **flat** as `codeloc`, and one aggregate avis rather than a
 * list of periods.
 */
export const aadlTxn = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  txn({
    status: 'READY',
    partner: 'AADL',
    account: { codeloc: '1112223334' },
    bills: [
      {
        billId: 'sbx_bill_6aadc0e200dba84e0bc28bfb_0',
        amount: 5400,
        fee: 0,
        label: 'Avis de paiement AADL',
        period: 'Août 2026',
        breakdown: {
          totalRent: 5000,
          totalCharges: 400,
          totalPenalties: 0,
          unpaidPeriods: 0,
          site: 'Cite Sandbox A',
          dueDate: 'Le 24 du mois',
        },
      },
    ],
    ...over,
  });
