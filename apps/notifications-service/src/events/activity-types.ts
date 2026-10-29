export const ACTIVITY_TYPES = [
  'deposit',
  'withdrawal',
  'transfer_sent',
  'transfer_received',
  'transfer_failed',
  'wallet_blocked',
  'wallet_unblocked',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];
