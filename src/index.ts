/**
 * `@terminaldz/billpay-sdk` — the official Node.js SDK for the OneClickDz Bill
 * Payment API (`/v3`).
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
  BillPayNotFoundError,
  BillPayInternalError,
  BillPayTimeoutError,
  BillPayNetworkError,
  BillPayAbortError,
  BillPayPollTimeoutError,
} from './errors.js';

export { newRef, payRefFor, isValidRef, REF_MAX_LENGTH } from './ref.js';

export { PARTNERS, TERMINAL_STATUSES, isTerminal } from './types.js';

export type {
  AadlNumberAccount,
  AccountIdentifier,
  AdeInvoiceAccount,
  Bill,
  BillPayClientOptions,
  ContractNumberAccount,
  DiscoverAck,
  DiscoverParams,
  ElectronicPaymentKeyAccount,
  ErrorEnvelope,
  FetchLike,
  GetByRefParams,
  HookContext,
  ListParams,
  Partner,
  PartnersMap,
  PartnerStatus,
  PayAck,
  PayParams,
  PhoneNumberAccount,
  PhoneNumberSnakeAccount,
  PollOptions,
  Receipt,
  ReferenceAccount,
  ResponseMeta,
  SonelgazInvoiceAccount,
  SuccessEnvelope,
  SyncErrorCode,
  TerminalErrorCode,
  TerminalStatus,
  Transaction,
  TransactionList,
  TransactionStatus,
  ValidateResult,
} from './types.js';
