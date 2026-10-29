export const ACTIVITY_TYPES = [
  'deposit',
  'withdrawal',
  'transfer_sent',
  'transfer_received',
  'transfer_failed',
  'wallet_blocked',
  'wallet_unblocked',
  'split_bill_created',
  'split_share_paid',
  'split_bill_settled',
  'split_share_overdue',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];
