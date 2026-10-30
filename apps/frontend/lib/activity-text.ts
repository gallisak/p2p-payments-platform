import { ActivityItem } from './types';

export const ACTIVITY_LABELS: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  transfer_sent: 'Transfer sent',
  transfer_received: 'Transfer received',
  transfer_failed: 'Transfer failed',
  wallet_blocked: 'Wallet blocked',
  wallet_unblocked: 'Wallet unblocked',
  split_bill_created: 'New split bill',
  split_share_paid: 'Share paid',
  split_bill_settled: 'Bill settled',
  split_share_overdue: 'Share overdue',
};

export function activityAmount({ data }: ActivityItem): string | null {
  const amount = data.amount ?? data.totalAmount;
  return typeof amount === 'string' ? `${amount} ${typeof data.currency === 'string' ? data.currency : ''}`.trim() : null;
}

export function activityDetail({ data }: ActivityItem): string | null {
  return typeof data.title === 'string' ? data.title : null;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}
