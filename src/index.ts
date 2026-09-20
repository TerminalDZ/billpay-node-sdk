/**
 * `@terminaldz/billpay-sdk` — Node.js/TypeScript SDK for the OneClickDz Bill Payment API (`/v3`).
 * Zero runtime dependencies; no `node:` imports, so the same build runs in Node 18+ and browsers.
 *
 * @see https://docs.oneclickdz.com
 */

export { BillPayClient, DEFAULT_BASE_URL } from './client.js';
export { BillsResource } from './bills.js';

export {
  BillPayError,
  BillPayAuthError,
  BillPayValidationError,
  BillPayConflictError,
  BillPayUnavailableError,
  BillPayRateLimitError,
  BillPayNotFoundError,
  BillPayInternalError,
  BillPayTimeoutError,
  BillPayNetworkError,
  BillPayAbortError,
  BillPayPollTimeoutError,
} from './errors.js';

export { newRef, payRefFor, isValidRef, REF_MAX_LENGTH } from './ref.js';

export { PARTNERS, TERMINAL_STATUSES, isTerminal, environmentOf } from './types.js';

export type {
  AadlAccount,
  AccountIdentifier,
  ApiEnvironment,
  Avis,
  Bill,
  BillBreakdown,
  BillPayClientOptions,
  DiscoverAck,
  DiscoverParams,
  ElectronicPaymentKeyAccount,
  ErrorEnvelope,
  FetchLike,
  GetByRefParams,
  HookContext,
  KeyErrorCode,
  ListParams,
  MultiBillPayParams,
  Partner,
  PartnersMap,
  PartnerStatus,
  PayAck,
  PayParams,
  PhoneNumberAccount,
  PollOptions,
  Receipt,
  ResponseMeta,
  SeaalAccount,
  SingleBillPayParams,
  SonelgazAccount,
  SuccessEnvelope,
  SyncErrorCode,
  TerminalErrorCode,
  TerminalStatus,
  Transaction,
  TransactionList,
  TransactionStatus,
  UnenvelopedError,
  ValidateResult,
} from './types.js';
