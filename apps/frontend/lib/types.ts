export interface Wallet {
  id: string;
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
}

export interface Transfer {
  id: string;
  status: string;
  fromWalletId: string;
  fromCurrency: string | null;
  amount: string;
  recipientEmail: string;
  toCurrency: string;
  creditAmount: string | null;
  rate: string | null;
  failureReason: string | null;
  failureDetail: string | null;
  awaitingRetry: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ActivityItem {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

export type Section<T> = { status: 'ok'; data: T } | { status: 'unavailable'; error: string };

export interface Dashboard {
  wallets: Section<Wallet[]>;
  transfers: Section<Transfer[]>;
  activity: Section<ActivityPage>;
}

export const CURRENCIES = ['USD', 'EUR', 'UAH'];

export interface SplitShare {
  id: string;
  participantId: string;
  participantEmail: string;
  amount: string;
  status: string;
  transferId: string | null;
  paidAt: string | null;
}

export interface SplitBill {
  id: string;
  title: string;
  creatorId: string;
  creatorEmail: string;
  currency: string;
  totalAmount: string;
  creatorAmount: string;
  split: string;
  dueAt: string;
  status: string;
  createdAt: string;
  shares: SplitShare[];
}
