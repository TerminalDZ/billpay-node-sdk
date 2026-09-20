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

/**
 * The one selection the payment will carry, and the caller's rather than ours.
 *
 * {@link PayParams} already makes "both" and "neither" compile errors, so this guard is
 * for the JavaScript caller the types never reach. It matters more than the other two
 * guards do: `billId` and `billIds` are mutually exclusive on the wire, so an SDK that
 * quietly picked one of a contradictory pair would settle a selection nobody asked for,
 * with money behind it. Refusing in the server's own words is the honest answer.
 *
 * Nothing else about the selection is checked here. An empty array, a fifty-first id, a
 * repeated one — each is refused by the API with a sentence that names the problem, and
 * a limit copied into the SDK is a limit that goes stale on the day the server relaxes it.
 */
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

/**
 * Hands a transaction to the caller's `onPoll`, and refuses to let that call break the
 * wait.
 *
 * A poll loop can have a payment behind it, so a bug in an observer — a Vue component
 * that unmounted, a logger with a bad format string — must not be able to abandon it.
 * The exception is dropped rather than surfaced because there is no honest way to
 * report it: it did not come from the API, and raising it would make a healthy payment
 * look like a failed one.
 */
const notify = (hook: PollOptions['onPoll'], transaction: Transaction): void => {
  if (!hook) return;
  try {
    hook(transaction);
  } catch {
    /* Deliberately swallowed — see above. */
  }
};

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
   * Pay one discovered bill, or several of them as one order. `POST /v3/bills/pay`.
   *
   * Name the bills one way or the other — `billId` for a single bill,
   * {@link MultiBillPayParams `billIds`} for a selection — and only the key you used is
   * sent. Both together, or neither, is refused: by the compiler if you have types, and
   * by this method before a request is spent if you do not.
   *
   * ```ts
   * await client.bills.pay({ transactionId, billIds: ids, ref: payRefFor(discoveryRef) });
   * ```
   *
   * A selection settles as **one portal order and one card payment**, so it is charged
   * one fee on the combined total rather than one fee per bill — with SEAAL's 30 DZD
   * floor that is 30.00 for five factures instead of 150.00, which is the whole point of
   * the form. Every id has to be on the transaction or none of them is paid, and the
   * settled transaction reports the aggregate: read `total`, and keep your own list of
   * the ids you sent.
   *
   * Give the payment its own `ref` — `payRefFor(discoveryRef)` derives one. The docs
   * describe that as mandatory and promise `403 DUPLICATED_REF` for the discovery ref;
   * the live deployment in fact accepts it. Treat the distinct ref as the convention it
   * is: cheap, unambiguous in your own logs, and already correct if the server starts
   * enforcing what it documents.
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
   * Two fields are **not** populated here, because the server projects them away:
   * `bills` always comes back as `[]`, and `error` is absent or defaulted on failed
   * rows. Use {@link get} for either. This is a server-side quirk, not an SDK one.
   *
   * Counts come from `meta`, not the body: `data` is a bare array. `meta` itself is
   * optional across the API, so each count falls back to what this page can prove —
   * a `total` derived that way is a floor, not the real total.
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
   * The only call that returns `bills`, so read it before acting on a discovery.
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
   *
   * The server names the file in `Content-Disposition`, which a browser is not allowed
   * to read: the header is not CORS-safelisted and the API exposes none. So in a browser
   * the fallback name is the normal outcome, and it is built from `Content-Type` — which
   * *is* safelisted — so that `saveAs(blob, receipt.filename)` still produces something
   * the operating system will open.
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
   * Download AADL's *avis de paiement*. `GET /v3/bills/transactions/{id}/avis`.
   *
   * **The live deployment does not route this yet.** The endpoint is fully documented
   * and implemented here against that contract, but today the server answers a
   * router-level miss, which the transport surfaces as `BillPayNotFoundError`. Expect
   * that, keep the call behind the same `catch` you use for a missing receipt, and the
   * day it ships your code will start returning a PDF instead — with no edit on your
   * side, which is the point of shipping it now.
   *
   * Write that branch today with {@link BillPayError.isEndpointMissing}, which tells the
   * two kinds of `404` apart. Both arrive as `NOT_FOUND`, and they mean opposite things:
   *
   * ```ts
   * try {
   *   const avis = await client.bills.avis(transactionId);
   *   return avis.bytes;
   * } catch (err) {
   *   if (err instanceof BillPayNotFoundError && err.isEndpointMissing) {
   *     return null; // Not routed here yet. Offer the receipt, check again another day.
   *   }
   *   throw err; // A real refusal: not yours, not AADL, or no housing file resolved.
   * }
   * ```
   *
   * **AADL only.** Every other partner answers `404` — read `partner` on the
   * transaction and offer the download only when it is `AADL`. For everyone else
   * {@link receipt} is the document you want, and it is not the same document: the
   * receipt proves your payment went through, the avis is AADL's own statement of what
   * the housing file owes.
   *
   * **Addressed by transaction, never by housing file.** There is no `codeloc`
   * parameter and none is accepted — if your code builds one, it is calling the wrong
   * thing. That is deliberate: AADL's own export page answers with a PDF for any code
   * it is given, so proxying a caller-supplied one would turn this into a way to
   * enumerate other people's files. Resolving the file from a transaction you own makes
   * that impossible.
   *
   * The transaction does **not** have to be `SUCCESS` — unlike the receipt, any AADL
   * transaction of yours that has resolved a bill can produce an avis, so a `READY`
   * discovery is enough. Fetch it fresh each time: AADL regenerates the document every
   * period, which is why the response says `no-store`.
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

  /**
   * Shared poll loop: exponential backoff to a ceiling, abortable, deadline-bounded.
   *
   * Two rules hold it together, and both exist because the thing being watched may be a
   * payment in flight.
   *
   * **A failed read is not a failed transaction.** A 5xx, a rate limit, a dropped socket
   * — none of them says anything about the payment, so none of them ends the wait. The
   * loop keeps the last status it did see and carries on to the deadline. Only a refusal
   * that will not change its mind — a 404, a 401, a malformed id — is rethrown, because
   * polling harder will not fix any of those. Abandoning a watch over a five-second blip
   * is how an in-flight payment ends up with nobody looking at it.
   *
   * **`timeoutMs` bounds the whole wait, not just the naps.** The deadline is enforced
   * with a signal handed to every read, so a request that hangs, or a `Retry-After` the
   * transport is sleeping through, cannot push the give-up past the budget the caller
   * set. Without that, one read could outlast the timeout on its own and the handoff to
   * background reconciliation would fire long after the request it belonged to was gone.
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

    // One signal for both reasons to stop, plus a flag to tell them apart afterwards:
    // the caller changing their mind is an abort, the deadline arriving is a poll
    // timeout, and a caller who catches the wrong one reconciles the wrong thing.
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
          // `isRetryable` is already the SDK's answer to "would the same request
          // plausibly work later?", and it is `false` for an abort, so the cancellation
          // paths fall through to the outer catch untouched.
          if (!(e instanceof BillPayError) || !e.isRetryable) throw e;
          lastFailure = e;
        }

        if (Date.now() + interval >= deadline) throw giveUp();

        await sleep(interval, ctl.signal);
        interval = Math.min(interval * 2, maxIntervalMs);
      }
    } catch (e) {
      // The deadline signal and the caller's are the same signal by the time a read or a
      // nap sees it, so this is where they are told apart again. The caller's own abort
      // wins if both fired: they asked to stop, and that is a different event from a
      // budget running out.
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
