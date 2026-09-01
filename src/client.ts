/**
 * The client entry point.
 */

import { BillsResource } from './bills.js';
import { BillPayValidationError } from './errors.js';
import { Transport } from './http.js';
import type {
  BillPayClientOptions,
  PartnersMap,
  ValidateResult,
} from './types.js';

/** The production API. */
export const DEFAULT_BASE_URL = 'https://billapi.oneclickdz.com';

/**
 * A client for one partner key.
 *
 * Holds no global state, so clients with different keys — a sandbox one and a
 * production one, say — can coexist in the same process without interfering.
 *
 * ```ts
 * const client = new BillPayClient({ apiKey: process.env.BILLPAY_API_KEY! });
 * const { key } = await client.validate();
 * console.log(key.type); // 'SANDBOX' | 'PRODUCTION'
 * ```
 */
export class BillPayClient {
  /** Discover, pay, look up, download, and the polling helpers. */
  readonly bills: BillsResource;

  private readonly transport: Transport;

  constructor(options: BillPayClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new BillPayValidationError('apiKey is required.', { code: 'ERR_VALIDATION' });
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new BillPayValidationError(
        'No fetch implementation available. Use Node 18+, or pass one via the `fetch` option.',
        { code: 'ERR_VALIDATION' },
      );
    }

    this.transport = new Transport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 2,
      fetch: fetchImpl,
      onRequest: options.onRequest,
      onResponse: options.onResponse,
    });

    this.bills = new BillsResource(this.transport);
  }

  /**
   * Verify the key and report which environment it belongs to.
   * `GET /v3/validate`.
   *
   * `key.type` is authoritative: a `SANDBOX` key never touches a real portal and moves
   * no money, whatever base URL you point it at.
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
   * Partner availability. `GET /v3/partners`.
   *
   * `SEAAL` and `AADL` are currently `UNAVAILABLE` in both environments; sending them
   * to discover or pay answers `503 PARTNER_UNAVAILABLE`. Check this before offering a
   * partner in a UI rather than discovering it at payment time.
   */
  async partners(signal?: AbortSignal): Promise<PartnersMap> {
    const { data } = await this.transport.request<PartnersMap>({
      method: 'GET',
      path: '/v3/partners',
      signal,
    });
    return data;
  }
}
