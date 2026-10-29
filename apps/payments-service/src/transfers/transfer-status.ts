export const TRANSFER_STATUSES = [
  'pending',
  'checked',
  'funds_held',
  'confirmed',
  'compensating',
  'completed',
  'failed',
] as const;

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TransferStatus[] = ['completed', 'failed'];

export type FailureReason =
  | 'source_wallet_not_found'
  | 'source_wallet_blocked'
  | 'recipient_not_found'
  | 'recipient_blocked'
  | 'recipient_not_allowed'
  | 'same_wallet'
  | 'limit_exceeded'
  | 'daily_limit_exceeded'
  | 'insufficient_funds'
  | 'amount_too_small'
  | 'rate_expired'
  | 'wallet_blocked'
  | 'rejected_by_ledger'
  | 'ledger_unavailable'
  | 'timed_out';
