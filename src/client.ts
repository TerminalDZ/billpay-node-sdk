/**
 * The client entry point.
 */

import { BillsResource } from './bills.js';
import { BillPayValidationError } from './errors.js';
import { Transport } from './http.js';
import type {
  ApiEnvironment,
  BillPayClientOptions,
  FetchLike,
  PartnersMap,
  ValidateResult,
} from './types.js';

/**
 * The API, for both environments.
 *
 * Sandbox and production share this host — the key decides which one you are talking
 * to, not the URL. So there is nothing to switch when you go live, and nothing to
 * mis-switch: read `apiKey.type` from {@link BillPayClient.validate} if you need to know
 * where you are.
 */
export const DEFAULT_BASE_URL = 'https://api.oneclickdz.com';

/**
 * Settle the base URL, and refuse an unusable one here rather than on the first request.
 *
 * A blank value counts as "not given". This is not pedantry about whitespace: `baseUrl`
 * almost always arrives from the environment, and the natural way to say "use the
 * default" in a `.env` file is `BILLPAY_BASE_URL=`, which reaches the constructor as the
 * empty string. `??` alone would take that literally, and every request would then fail
 * deep in the transport with a bare `TypeError: Invalid URL` — from `new URL('')`, thrown
 * by a line the caller never wrote, carrying no `code` and no hint about which option was
 * at fault.
 *
 * Anything else is parsed once, up front, so a typo in the host is a
 * {@link BillPayValidationError} naming the option at construction time instead of a
 * different, stranger failure on every call that follows.
 */
const resolveBaseUrl = (baseUrl?: string): string => {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return DEFAULT_BASE_URL;

  try {
    new URL(trimmed);
  } catch {
    throw new BillPayValidationError(
      `baseUrl must be an absolute URL, e.g. '${DEFAULT_BASE_URL}'. Received: '${trimmed}'.`,
      { code: 'ERR_VALIDATION' },
    );
  }
  return trimmed;
};

/**
 * A client for one partner key.
 *
 * Holds no global state, so clients with different keys — a sandbox one and a
 * production one, say — can coexist in the same process without interfering.
 *
 * ```ts
 * const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });
 * const { apiKey } = await client.validate();
 * console.log(apiKey.type); // 'SANDBOX' | 'PRODUCTION'
 * ```
 *
 * Browsers are a supported caller. The API sends `access-control-allow-origin: *` and
 * allows `x-access-token`, so a front-end can talk to it with no dev proxy — which also
 * means a key shipped to a browser is a key you have published. Use a sandbox key in
 * anything a customer can open, and keep the production one behind your own server.
 */
export class BillPayClient {
  /** Discover, pay, look up, download, and the polling helpers. */
  readonly bills: BillsResource;

  private readonly transport: Transport;

  constructor(options: BillPayClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new BillPayValidationError('apiKey is required.', { code: 'ERR_VALIDATION' });
    }

    if (options.fetch === undefined && typeof globalThis.fetch !== 'function') {
      throw new BillPayValidationError(
        'No fetch implementation available. Use Node 18+, or pass one via the `fetch` option.',
        { code: 'ERR_VALIDATION' },
      );
    }

    // The transport calls this as a method on its own config object, so an unbound
    // `globalThis.fetch` arrives with the wrong `this`. Node does not care; a browser
    // throws `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`,
    // which turns every call from a page into a BillPayNetworkError. Bind it here.
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    this.transport = new Transport({
      apiKey: options.apiKey,
      baseUrl: resolveBaseUrl(options.baseUrl),
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 2,
      fetch: fetchImpl,
      onRequest: options.onRequest,
      onResponse: options.onResponse,
    });

    this.bills = new BillsResource(this.transport);
  }

  /**
   * Verify the key and report who it belongs to. `GET /v3/validate`.
   *
   * The environment lives at **`apiKey.type`** — one level deeper than it reads, and
   * next to an `apiKey.key` string that is the key itself, not its kind. {@link
   * environment} spares you the distinction. Whichever you use, that field is
   * authoritative: a `SANDBOX` key never touches a real portal and moves no money,
   * whatever base URL you point it at.
   *
   * This is also the one response in the API with **no `meta`**, which is why the
   * envelope types it as optional.
   *
   * Do not log the result wholesale: `apiKey.key` is the credential.
   */
  async validate(signal?: AbortSignal): Promise<ValidateResult> {
    const { data } = await this.transport.request<ValidateResult>({
      method: 'GET',
      path: '/v3/validate',
      signal,
    });
    return data;
  }

  /**
   * Which environment this key belongs to. A one-field read of {@link validate}.
   *
   * ```ts
   * if ((await client.environment()) === 'PRODUCTION') confirmWithTheOperator();
   * ```
   */
  async environment(signal?: AbortSignal): Promise<ApiEnvironment> {
    const { apiKey } = await this.validate(signal);
    return apiKey.type;
  }

  /**
   * Partner availability. `GET /v3/bills/partners`.
   *
   * The path is under `/v3/bills`; a bare `/v3/partners` is a 404.
   *
   * This map is the only honest answer to "can I offer this biller today?". Availability
   * changes in both environments without an SDK release, so call this when you build the
   * partner picker and render from the result — rather than hard-coding a list, or
   * trusting a sentence in a document, or discovering at payment time that a biller has
   * been switched off and answering `503 PARTNER_UNAVAILABLE` to a customer who has
   * already typed their reference.
   */
  async partners(signal?: AbortSignal): Promise<PartnersMap> {
    const { data } = await this.transport.request<PartnersMap>({
      method: 'GET',
      path: '/v3/bills/partners',
      signal,
    });
    return data;
  }
}
