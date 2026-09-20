/**
 * The `bills` resource: discover, pay, look up, download, and wait.
 */

import {
  BillPayAbortError,
  BillPayError,
  BillPayPollTimeoutError,
  BillPayValidationError,
} from './errors.js';
import { extensionForContentType, filenameFromDisposition, type Transport } from './http.js';
import { isValidRef, REF_MAX_LENGTH } from './ref.js';
import {
  isTerminal,
  type Avis,
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

/** Exactly one of `billId` / `billIds`, for JavaScript callers the types do not reach. Other limits are the API's. */
const billSelection = (params: PayParams): { billId: string } | { billIds: string[] } => {
  if ((params.billId === undefined) === (params.billIds === undefined)) {
    throw new BillPayValidationError('Provide exactly one of billId or billIds.', {
      code: 'ERR_VALIDATION',
    });
  }
  return params.billIds === undefined ? { billId: params.billId } : { billIds: params.billIds };
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

/** Calls `onPoll`; an observer's exception must not abandon a wait that may have money behind it. */
const notify = (hook: PollOptions['onPoll'], transaction: Transaction): void => {
  if (!hook) return;
  try {
    hook(transaction);
  } catch {
    /* Deliberately swallowed. */
  }
};

export class BillsResource {
  constructor(private readonly transport: Transport) {}

  /**
   * Start a discovery. `POST /v3/bills/discover`.
   *
   * The response is an acknowledgement (`PENDING`). Follow it with {@link waitForReady}.
   * Never retried; recover with {@link getByRef}.
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
   * Pay one bill (`billId`) or several as one order (`billIds`). `POST /v3/bills/pay`.
   *
   * ```ts
   * await client.bills.pay({ transactionId, billIds: ids, ref: payRefFor(discoveryRef) });
   * ```
   *
   * `ref` must be new: the discovery ref, or any ref still in use for the partner, is
   * refused with `403 DUPLICATED_REF`. The returned `ref` is the discovery ref.
   * The response is an acknowledgement (`PROCESSING`). Follow it with
   * {@link waitForTerminal}. Never retried; read the transaction instead.
   */
  async pay(params: PayParams, signal?: AbortSignal): Promise<PayAck> {
    assertTransactionId(params.transactionId);
    assertRef(params.ref);
    const selection = billSelection(params);
    const { data } = await this.transport.request<PayAck>({
      method: 'POST',
      path: '/v3/bills/pay',
      body: { transactionId: params.transactionId, ...selection, ref: params.ref },
      signal,
    });
    return data;
  }

  /**
   * List your transactions, newest first. `GET /v3/bills/transactions`.
   *
   * Rows carry the same fields as {@link get}. Counts come from `meta`, falling back to
   * the page itself when the server omits them.
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
      total: envelope.meta?.total ?? data.length,
      limit: envelope.meta?.limit ?? data.length,
      offset: envelope.meta?.offset ?? 0,
    };
  }

  /**
   * Look a transaction up by its discovery ref. `GET /v3/bills/transactions/by-ref`.
   *
   * The recovery path after a timed-out `discover`: `404` means it was never created.
   * A pay ref never resolves here.
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

  /** Fetch one transaction. `GET /v3/bills/transactions/{id}`. A transaction that is not yours is `404`. */
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
   * Available once the transaction is `SUCCESS`; otherwise `BillPayNotFoundError`.
   * Sandbox receipts are PNG images.
   */
  async receipt(transactionId: string, signal?: AbortSignal): Promise<Receipt> {
    assertTransactionId(transactionId);
    const res = await this.transport.requestRaw({
      method: 'GET',
      path: `/v3/bills/transactions/${transactionId}/receipt`,
      signal,
    });
    const contentType = res.headers.get('content-type');
    return {
      bytes: res.bytes,
      contentType: contentType ?? 'application/octet-stream',
      filename:
        filenameFromDisposition(res.headers) ??
        `receipt-${transactionId}${extensionForContentType(contentType)}`,
      requestId: res.headers.get('x-request-id'),
    };
  }

  /**
   * Download AADL's avis de paiement (PDF). `GET /v3/bills/transactions/{id}/avis`.
   *
   * Available for an `AADL` transaction from `READY` onwards, before and after payment.
   * `BillPayNotFoundError` for any other partner, an unknown transaction, a sandbox key,
   * or while the notice is not available yet. Not cached server-side: fetch it when needed.
   */
  async avis(transactionId: string, signal?: AbortSignal): Promise<Avis> {
    assertTransactionId(transactionId);
    const res = await this.transport.requestRaw({
      method: 'GET',
      path: `/v3/bills/transactions/${transactionId}/avis`,
      signal,
    });
    return {
      bytes: res.bytes,
      contentType: res.headers.get('content-type') ?? 'application/pdf',
      filename: filenameFromDisposition(res.headers) ?? `avis_${transactionId}.pdf`,
      requestId: res.headers.get('x-request-id'),
    };
  }

  /**
   * Poll until discovery finishes. Resolves on `READY` (read `bills`; empty means nothing
   * is due) or on a terminal status (a `FAILED` discovery carries `error`).
   */
  waitForReady(transactionId: string, opts: PollOptions = {}): Promise<Transaction> {
    return this.poll(transactionId, (t) => t.status === 'READY' || isTerminal(t.status), opts);
  }

  /**
   * Poll until the payment reaches `SUCCESS`, `FAILED` or `REFUNDED`.
   *
   * `UNKNOWN` is not terminal: the helper keeps waiting through it. Bound the wait with
   * `timeoutMs` and handle {@link BillPayPollTimeoutError} (`lastStatus` says where it was).
   */
  waitForTerminal(transactionId: string, opts: PollOptions = {}): Promise<Transaction> {
    return this.poll(transactionId, (t) => isTerminal(t.status), opts);
  }

  /**
   * Poll loop: exponential backoff to a ceiling, abortable, deadline-bounded.
   *
   * A retryable read failure (5xx, 429, network, timeout) does not end the wait; a
   * definitive refusal (404, 401, validation) is rethrown. `timeoutMs` bounds the whole
   * wait, reads included.
   */
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
    let lastFailure: BillPayError | undefined;

    // One signal for both stop reasons; the flag tells a deadline from a caller abort.
    let deadlineReached = false;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      deadlineReached = true;
      ctl.abort();
    }, timeoutMs);
    const onCallerAbort = (): void => ctl.abort();
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const giveUp = (): BillPayPollTimeoutError =>
      new BillPayPollTimeoutError(
        `Transaction ${transactionId} did not settle within ${timeoutMs}ms ` +
          `(last status: ${last?.status ?? 'never read'}).`,
        { transactionId, lastStatus: last?.status, cause: lastFailure },
      );

    try {
      for (;;) {
        if (opts.signal?.aborted) throw new BillPayAbortError();

        try {
          last = await this.get(transactionId, ctl.signal);
          notify(opts.onPoll, last);
          if (done(last)) return last;
        } catch (e) {
          if (!(e instanceof BillPayError) || !e.isRetryable) throw e;
          lastFailure = e;
        }

        if (Date.now() + interval >= deadline) throw giveUp();

        await sleep(interval, ctl.signal);
        interval = Math.min(interval * 2, maxIntervalMs);
      }
    } catch (e) {
      // The caller's own abort wins over the deadline when both fired.
      if (e instanceof BillPayAbortError && deadlineReached && !opts.signal?.aborted) {
        throw giveUp();
      }
      throw e;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
