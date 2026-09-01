/** Shared fake-fetch plumbing for the unit suite. */

import type { FetchLike } from '../../src/index.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface StubResponse {
  status?: number;
  json?: unknown;
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

/** A success envelope. */
export const ok = <T>(data: T, meta: Record<string, unknown> = {}): unknown => ({
  success: true,
  data,
  meta: { timestamp: '2026-09-01T00:00:00.000Z', ...meta },
  requestId: 'req_test000000000000000000',
});

/** An error envelope. */
export const err = (code: string, message = 'boom', details?: unknown): unknown => ({
  success: false,
  error: { code, message, ...(details !== undefined ? { details } : {}) },
  requestId: 'req_test000000000000000000',
});

/** A valid 24-char lowercase hex transaction id. */
export const TXN_ID = '6a96b2336ff709bcb6efed15';

/** A transaction body with sensible defaults. */
export const txn = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  transactionId: TXN_ID,
  ref: 'ref-1',
  type: 'discovery',
  status: 'PENDING',
  partner: 'ADE',
  account: { reference: '0123456789012345678901234' },
  currency: 'DZD',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  completedAt: null,
  ...over,
});
