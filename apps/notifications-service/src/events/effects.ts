import { ActivityType } from './activity-types';
import { Envelope, EventSource, InvalidEnvelopeError } from './envelope';

export interface WalletUpdate {
  walletId: string;
  ownerId: string;
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
  streamVersion: number;
  occurredAt: Date;
}

export interface TransferUpdate {
  transferId: string;
  ownerId: string;
  recipientId: string | null;
  status: string;
  view: Record<string, unknown>;
  streamVersion: number;
  occurredAt: Date;
}

export interface ActivityInput {
  userId: string;
  type: ActivityType;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export interface Effects {
  wallet: WalletUpdate | null;
  transfer: TransferUpdate | null;
  activities: ActivityInput[];
}

function field(payload: Record<string, unknown>, key: string, type: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidEnvelopeError(`${type}.payload.${key} must be a non-empty string`);
  }
  return value;
}

function optional(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

export function effectsOf(source: EventSource, e: Envelope): Effects {
  return source === 'ledger' ? ledgerEffects(e) : paymentsEffects(e);
}

function ledgerEffects(e: Envelope): Effects {
  if (!e.wallet) {
    throw new InvalidEnvelopeError('ledger events must carry a wallet snapshot');
  }
  const wallet: WalletUpdate = {
    walletId: e.streamId,
    ownerId: e.ownerId,
    ...e.wallet,
    streamVersion: e.streamVersion,
    occurredAt: e.occurredAt,
  };
  const activity = (type: ActivityType, data: Record<string, unknown>): ActivityInput => ({
    userId: e.ownerId,
    type,
    occurredAt: e.occurredAt,
    data: { walletId: e.streamId, ...data },
  });
  const p = e.payload;
  const activities: ActivityInput[] = [];
  switch (e.type) {
    case 'MoneyDeposited':
    case 'MoneyWithdrawn':
      activities.push(
        activity(e.type === 'MoneyDeposited' ? 'deposit' : 'withdrawal', {
          operationId: field(p, 'operationId', e.type),
          amount: field(p, 'amount', e.type),
          currency: field(p, 'currency', e.type),
        }),
      );
      break;
    case 'TransferCompleted':
      activities.push(
        activity('transfer_sent', {
          operationId: field(p, 'operationId', e.type),
          toWalletId: field(p, 'toWalletId', e.type),
          amount: field(p, 'amount', e.type),
          currency: field(p, 'currency', e.type),
          creditAmount: field(p, 'creditAmount', e.type),
          creditCurrency: field(p, 'creditCurrency', e.type),
        }),
      );
      break;
    case 'TransferReceived':
      activities.push(
        activity('transfer_received', {
          operationId: field(p, 'operationId', e.type),
          fromWalletId: field(p, 'fromWalletId', e.type),
          amount: field(p, 'amount', e.type),
          currency: field(p, 'currency', e.type),
        }),
      );
      break;
    case 'WalletBlocked':
      activities.push(activity('wallet_blocked', {}));
      break;
    case 'WalletUnblocked':
      activities.push(activity('wallet_unblocked', {}));
      break;
  }
  return { wallet, transfer: null, activities };
}

function paymentsEffects(e: Envelope): Effects {
  const p = e.payload;
  if (typeof p.status !== 'string') {
    return { wallet: null, transfer: null, activities: [] };
  }
  const transfer: TransferUpdate = {
    transferId: e.streamId,
    ownerId: e.ownerId,
    recipientId: e.recipientId,
    status: p.status,
    view: p,
    streamVersion: e.streamVersion,
    occurredAt: e.occurredAt,
  };
  const activities: ActivityInput[] = [];
  if (e.type === 'TransferFailed') {
    activities.push({
      userId: e.ownerId,
      type: 'transfer_failed',
      occurredAt: e.occurredAt,
      data: {
        transferId: e.streamId,
        fromWalletId: optional(p, 'fromWalletId'),
        amount: field(p, 'amount', e.type),
        currency: optional(p, 'fromCurrency'),
        toCurrency: optional(p, 'toCurrency'),
        recipientEmail: optional(p, 'recipientEmail'),
        failureReason: optional(p, 'failureReason'),
      },
    });
  }
  return { wallet: null, transfer, activities };
}
