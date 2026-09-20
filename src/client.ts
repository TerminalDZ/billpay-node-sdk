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

/** The API host for both environments; the key decides which one you are talking to. */
export const DEFAULT_BASE_URL = 'https://api.oneclickdz.com';

/** Blank means "use the default" (an unset `BILLPAY_BASE_URL=` arrives as `''`); anything else must parse as a URL. */
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
 * A client for one partner key. Holds no global state; several clients can coexist.
 *
 * ```ts
 * const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });
 * ```
 *
 * Works in browsers too. A key shipped to a browser is a key you have published: use a
 * sandbox key there and keep the production key behind your own server.
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

    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation" in browsers.
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
   * Verify the key. `GET /v3/validate`. The environment is `apiKey.type`; see
   * {@link environment}. Do not log the result wholesale: `apiKey.key` is the credential.
   */
  async validate(signal?: AbortSignal): Promise<ValidateResult> {
    const { data } = await this.transport.request<ValidateResult>({
      method: 'GET',
      path: '/v3/validate',
      signal,
    });
    return data;
  }

  /** Which environment this key belongs to. */
  async environment(signal?: AbortSignal): Promise<ApiEnvironment> {
    const { apiKey } = await this.validate(signal);
    return apiKey.type;
  }

  /**
   * Partner availability. `GET /v3/bills/partners`. Read it when building the partner
   * picker; availability changes without an SDK release. A sandbox key sees every partner `ACTIVE`.
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
