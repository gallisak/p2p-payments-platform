import { formatCents, toCents } from './money';

export interface Posting {
  accountId: string;
  amount: string;
  currency: string;
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

export interface HoldPayload {
  holdId: string;
  amount: string;
  currency: string;
}

export interface TransferCompletedPayload {
  operationId: string;
  holdId: string;
  amount: string;
  currency: string;
  toWalletId: string;
  creditAmount: string;
  creditCurrency: string;
  postings: Posting[];
}

export interface TransferReceivedPayload {
  operationId: string;
  holdId: string;
  fromWalletId: string;
  amount: string;
  currency: string;
}

export interface WalletBlockedPayload {
  reason: string;
}

export type WalletUnblockedPayload = Record<string, never>;

export interface LedgerEventPayloads {
  WalletOpened: WalletOpenedPayload;
  MoneyDeposited: MoneyMovedPayload;
  MoneyWithdrawn: MoneyMovedPayload;
  HoldPlaced: HoldPayload;
  HoldReleased: HoldPayload;
  TransferCompleted: TransferCompletedPayload;
  TransferReceived: TransferReceivedPayload;
  WalletBlocked: WalletBlockedPayload;
  WalletUnblocked: WalletUnblockedPayload;
}

export type LedgerEventType = keyof LedgerEventPayloads;

export const CURRENT_SCHEMA_VERSION: Record<LedgerEventType, number> = {
  WalletOpened: 1,
  MoneyDeposited: 2,
  MoneyWithdrawn: 2,
  HoldPlaced: 1,
  HoldReleased: 1,
  TransferCompleted: 1,
  TransferReceived: 1,
  WalletBlocked: 1,
  WalletUnblocked: 1,
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

export function fxAccount(currency: string): string {
  return `fx:${currency}`;
}

function assertPositive(amount: bigint): void {
  if (amount <= 0n) {
    throw new Error(`Amount must be positive, got ${formatCents(amount)}`);
  }
}

function posting(accountId: string, amount: bigint, currency: string): Posting {
  return { accountId, amount: formatCents(amount), currency };
}

export function depositPostings(
  walletId: string,
  currency: string,
  amount: bigint,
): Posting[] {
  assertPositive(amount);
  return [
    posting(externalAccount(currency), -amount, currency),
    posting(walletId, amount, currency),
  ];
}

export function withdrawalPostings(
  walletId: string,
  currency: string,
  amount: bigint,
): Posting[] {
  assertPositive(amount);
  return [
    posting(walletId, -amount, currency),
    posting(externalAccount(currency), amount, currency),
  ];
}

export interface TransferLeg {
  walletId: string;
  currency: string;
  amount: bigint;
}

export function transferPostings(from: TransferLeg, to: TransferLeg): Posting[] {
  assertPositive(from.amount);
  assertPositive(to.amount);
  if (from.currency === to.currency) {
    if (from.amount !== to.amount) {
      throw new Error('A same-currency transfer must credit what it debits');
    }
    return [
      posting(from.walletId, -from.amount, from.currency),
      posting(to.walletId, to.amount, to.currency),
    ];
  }
  return [
    posting(from.walletId, -from.amount, from.currency),
    posting(fxAccount(from.currency), from.amount, from.currency),
    posting(fxAccount(to.currency), -to.amount, to.currency),
    posting(to.walletId, to.amount, to.currency),
  ];
}

export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) {
    throw new Error('A ledger operation needs at least two postings');
  }
  const totals = new Map<string, bigint>();
  for (const p of postings) {
    totals.set(p.currency, (totals.get(p.currency) ?? 0n) + toCents(p.amount));
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) {
      throw new Error(
        `Postings do not balance in ${currency}: total ${formatCents(total)}`,
      );
    }
  }
}
