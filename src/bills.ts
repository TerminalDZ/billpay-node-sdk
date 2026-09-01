/**
 * The `bills` resource: discover, pay, look up, download, and wait.
 */

import { BillPayAbortError, BillPayPollTimeoutError, BillPayValidationError } from './errors.js';
import { filenameFromDisposition, type Transport } from './http.js';
import { isValidRef, REF_MAX_LENGTH } from './ref.js';
import {
  isTerminal,
  type DiscoverAck,
  type DiscoverParams,
  type GetByRefParams,
  type ListParams,
  type PayAck,
  type PayParams,
  type PollOptions,
  type Receipt,
  type Transaction,
  type TransactionList,
} from './types.js';

const TXN_ID = /^[0-9a-f]{24}$/;

/** 24-char lowercase hex, matching `paySchema`. Caught here to save a round trip. */
const assertTransactionId = (id: string): void => {
  if (!TXN_ID.test(id)) {
    throw new BillPayValidationError(
      'transactionId must be a 24-character lowercase hexadecimal string.',
      { code: 'ERR_VALIDATION' },
    );
  }
};

const assertRef = (ref: string, field = 'ref'): void => {
  if (!isValidRef(ref)) {
    throw new BillPayValidationError(
      `${field} is required and must be at most ${REF_MAX_LENGTH} characters.`,
      { code: 'ERR_VALIDATION' },
    );
  }
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new BillPayAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new BillPayAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class BillsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Start a discovery. `POST /v3/bills/discover`.
   *
   * The `200` is an acknowledgement, not a result: the returned status is always
   * `PENDING`. Follow it with {@link waitForReady} and read `bills` from there.
   *
   * Not retried on failure — see {@link getByRef} for the recovery path.
   */
  async discover(params: DiscoverParams, signal?: AbortSignal): Promise<DiscoverAck> {
    assertRef(params.ref);
    const { data } = await this.transport.request<DiscoverAck>({
      method: 'POST',
      path: '/v3/bills/discover',
      body: { partner: params.partner, account: params.account, ref: params.ref },
      signal,
    });
    return data;
  }

  /**
   * Pay one discovered bill. `POST /v3/bills/pay`.
   *
   * `params.ref` must **differ from the discovery ref** — that transaction is still
   * live, so reusing its ref answers `403 DUPLICATED_REF`. Use `payRefFor(discoveryRef)`.
   *
   * The ref you pass is validated and then discarded. The returned `ref` is the
   * *discovery* ref, and that is the only one `getByRef` will ever resolve.
   *
   * The `200` is an acknowledgement; the status is always `PROCESSING`. Follow it with
   * {@link waitForTerminal}. Not retried — see {@link getByRef}.
   */
  async pay(params: PayParams, signal?: AbortSignal): Promise<PayAck> {
    assertTransactionId(params.transactionId);
    assertRef(params.ref);
    const { data } = await this.transport.request<PayAck>({
      method: 'POST',
      path: '/v3/bills/pay',
      body: { transactionId: params.transactionId, billId: params.billId, ref: params.ref },
      signal,
    });
    return data;
  }

  /**
   * List your transactions, newest first. `GET /v3/bills/transactions`.
   *
   * Two fields are **not** populated here, because the server projects them away:
   * `bills` always comes back as `[]`, and `error` is absent or defaulted on failed
   * rows. Use {@link get} for either. This is a server-side quirk, not an SDK one —
   * see the README's "Known drift" section.
   *
   * Counts come from `meta`, not the body: `data` is a bare array.
   */
  async list(params: ListParams = {}, signal?: AbortSignal): Promise<TransactionList> {
    const { data, envelope } = await this.transport.request<Transaction[]>({
      method: 'GET',
      path: '/v3/bills/transactions',
      query: {
        status: params.status,
        partner: params.partner,
        from: params.from,
        to: params.to,
        limit: params.limit,
        offset: params.offset,
      },
      signal,
    });
    return {
      transactions: data,
      total: envelope.meta.total ?? data.length,
      limit: envelope.meta.limit ?? data.length,
      offset: envelope.meta.offset ?? 0,
    };
  }

  /**
   * Look a transaction up by its **discovery** ref. `GET /v3/bills/transactions/by-ref`.
   *
   * This is the documented recovery path when a discover or pay POST fails at the
   * transport level and you do not know whether it landed. Call it with the ref you
   * sent to `discover`; if it returns a transaction, the POST succeeded.
   *
   * A pay ref never resolves here — the transaction keeps its discovery ref.
   */
  async getByRef(params: GetByRefParams, signal?: AbortSignal): Promise<Transaction> {
    assertRef(params.ref);
    const { data } = await this.transport.request<Transaction>({
      method: 'GET',
      path: '/v3/bills/transactions/by-ref',
      query: { ref: params.ref, partner: params.partner },
      signal,
    });
    return data;
  }

  /**
   * Fetch one transaction. `GET /v3/bills/transactions/{id}`.
   *
   * Someone else's transaction returns `404`, not `403`.
   */
  async get(transactionId: string, signal?: AbortSignal): Promise<Transaction> {
    assertTransactionId(transactionId);
    const { data } = await this.transport.request<Transaction>({
      method: 'GET',
      path: `/v3/bills/transactions/${transactionId}`,
      signal,
    });
    return data;
  }

  /**
   * Download a receipt. `GET /v3/bills/transactions/{id}/receipt`.
   *
   * Available for `SUCCESS` only. `receiptUrl` is set on every success even when the
   * manager holds no bytes, so this can still throw `BillPayNotFoundError` — always
   * handle that rather than assuming a URL means a file.
   */
  async receipt(transactionId: string, signal?: AbortSignal): Promise<Receipt> {
    assertTransactionId(transactionId);
    const res = await this.transport.requestRaw({
      method: 'GET',
      path: `/v3/bills/transactions/${transactionId}/receipt`,
      signal,
    });
    return {
      bytes: res.bytes,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameFromDisposition(res.headers) ?? `receipt-${transactionId}`,
      requestId: res.headers.get('x-request-id'),
    };
  }

  /**
   * Poll until discovery finishes, then return the transaction.
   *
   * Resolves on `READY` — check `bills`, which may legitimately be empty when nothing
   * is due or everything owed is under the 200 DZD floor. Also resolves on a terminal
   * status, because a discovery that failed will never become `READY`.
   */
  waitForReady(transactionId: string, opts: PollOptions = {}): Promise<Transaction> {
    return this.poll(transactionId, (t) => t.status === 'READY' || isTerminal(t.status), opts);
  }

  /**
   * Poll until the transaction reaches `SUCCESS`, `FAILED` or `REFUNDED`.
   *
   * `UNKNOWN` is **not** terminal and does not resolve this promise. It means the
   * outcome is under review and will settle as `SUCCESS` or `REFUNDED`; treating it as
   * a failure is the single most expensive mistake an integration can make, so this
   * helper keeps waiting. If you need to bound that wait, set `timeoutMs` and handle
   * {@link BillPayPollTimeoutError}, whose `lastStatus` tells you it was still
   * `UNKNOWN`.
   */
  waitForTerminal(transactionId: string, opts: PollOptions = {}): Promise<Transaction> {
    return this.poll(transactionId, (t) => isTerminal(t.status), opts);
  }

  /** Shared poll loop: exponential backoff to a ceiling, abortable, deadline-bounded. */
  private async poll(
    transactionId: string,
    done: (t: Transaction) => boolean,
    opts: PollOptions,
  ): Promise<Transaction> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxIntervalMs = opts.maxIntervalMs ?? 5_000;
    let interval = opts.intervalMs ?? 1_000;

    const deadline = Date.now() + timeoutMs;
    let last: Transaction | undefined;

    for (;;) {
      if (opts.signal?.aborted) throw new BillPayAbortError();

      last = await this.get(transactionId, opts.signal);
      if (done(last)) return last;

      if (Date.now() + interval >= deadline) {
        throw new BillPayPollTimeoutError(
          `Transaction ${transactionId} did not settle within ${timeoutMs}ms ` +
            `(last status: ${last.status}).`,
          { transactionId, lastStatus: last.status },
        );
      }

      await sleep(interval, opts.signal);
      interval = Math.min(interval * 2, maxIntervalMs);
    }
  }
}
