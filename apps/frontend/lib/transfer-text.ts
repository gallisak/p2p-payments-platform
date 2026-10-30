export const SAGA_STEPS = [
  { status: 'pending', label: 'Created' },
  { status: 'checked', label: 'Checked' },
  { status: 'funds_held', label: 'Funds held' },
  { status: 'confirmed', label: 'Confirmed' },
  { status: 'completed', label: 'Completed' },
];

export const STATUS_TEXT: Record<string, string> = {
  pending: 'Created',
  checked: 'Checked',
  funds_held: 'Funds held',
  confirmed: 'Confirmed',
  compensating: 'Cancelling, returning funds',
  completed: 'Completed',
  failed: 'Failed',
};

const FAILURE_TEXT: Record<string, string> = {
  source_wallet_not_found: 'Sender wallet not found',
  source_wallet_blocked: 'The sender wallet is blocked',
  recipient_not_found: 'Recipient not found',
  recipient_blocked: 'The recipient wallet is blocked',
  recipient_not_allowed: 'Transfers to this recipient are not allowed',
  same_wallet: 'You cannot transfer to the same wallet',
  limit_exceeded: 'Per-transfer limit exceeded',
  daily_limit_exceeded: 'Daily limit exceeded',
  insufficient_funds: 'Insufficient funds',
  amount_too_small: 'The amount is too small after conversion',
  rate_expired: 'The exchange rate expired, please try again',
  wallet_blocked: 'The wallet is blocked',
  rejected_by_ledger: 'The operation was rejected',
  ledger_unavailable: 'The service is temporarily unavailable',
  timed_out: 'The transfer did not finish in time',
};

export function failureText(reason: string | null): string {
  return (reason && FAILURE_TEXT[reason]) || 'The transfer failed';
}

export const isTerminal = (status: string) => status === 'completed' || status === 'failed';
