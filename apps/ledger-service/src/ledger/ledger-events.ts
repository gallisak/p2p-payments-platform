import { formatCents, toCents } from './money';

export interface Posting {
  accountId: string;
  amount: string;
}

export interface WalletOpenedPayload {
  ownerId: string;
  currency: string;
}

export interface MoneyMovedPayload {
  operationId: string;
  amount: string;
  currency: string;
  postings: Posting[];
}

export interface LedgerEventPayloads {
  WalletOpened: WalletOpenedPayload;
  MoneyDeposited: MoneyMovedPayload;
  MoneyWithdrawn: MoneyMovedPayload;
}

export type LedgerEventType = keyof LedgerEventPayloads;

export const CURRENT_SCHEMA_VERSION: Record<LedgerEventType, number> = {
  WalletOpened: 1,
  MoneyDeposited: 1,
  MoneyWithdrawn: 1,
};

export interface StoredEvent<T extends LedgerEventType = LedgerEventType> {
  type: T;
  schemaVersion: number;
  streamVersion: number;
  payload: LedgerEventPayloads[T];
}

export function externalAccount(currency: string): string {
  return `external:${currency}`;
}

function assertPositive(amount: bigint): void {
  if (amount <= 0n) {
    throw new Error(`Amount must be positive, got ${formatCents(amount)}`);
  }
}

export function depositPostings(
  walletId: string,
  currency: string,
  amount: bigint,
): Posting[] {
  assertPositive(amount);
  return [
    { accountId: externalAccount(currency), amount: formatCents(-amount) },
    { accountId: walletId, amount: formatCents(amount) },
  ];
}

export function withdrawalPostings(
  walletId: string,
  currency: string,
  amount: bigint,
): Posting[] {
  assertPositive(amount);
  return [
    { accountId: walletId, amount: formatCents(-amount) },
    { accountId: externalAccount(currency), amount: formatCents(amount) },
  ];
}

export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) {
    throw new Error('A ledger operation needs at least two postings');
  }
  const total = postings.reduce((sum, p) => sum + toCents(p.amount), 0n);
  if (total !== 0n) {
    throw new Error(`Postings do not balance: total ${formatCents(total)}`);
  }
}
