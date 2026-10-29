import { randomUUID } from 'crypto';

export interface LedgerEnvelopeInput {
  type: string;
  walletId?: string;
  ownerId?: string;
  streamVersion?: number;
  wallet?: Partial<{ currency: string; balance: string; held: string; blocked: boolean }>;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  eventId?: string;
}

export function ledgerEnvelope(input: LedgerEnvelopeInput) {
  return {
    eventId: input.eventId ?? randomUUID(),
    type: input.type,
    schemaVersion: 1,
    streamId: input.walletId ?? randomUUID(),
    streamVersion: input.streamVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ownerId: input.ownerId ?? randomUUID(),
    wallet: { currency: 'USD', balance: '0.00', held: '0.00', blocked: false, ...input.wallet },
    payload: input.payload ?? {},
    metadata: {},
  };
}

export interface PaymentsEnvelopeInput {
  type: string;
  transferId?: string;
  ownerId?: string;
  recipientId?: string | null;
  streamVersion?: number;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  eventId?: string;
}

export function paymentsEnvelope(input: PaymentsEnvelopeInput) {
  const transferId = input.transferId ?? randomUUID();
  return {
    eventId: input.eventId ?? randomUUID(),
    type: input.type,
    schemaVersion: 1,
    streamId: transferId,
    streamVersion: input.streamVersion ?? 1,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ownerId: input.ownerId ?? randomUUID(),
    recipientId: input.recipientId ?? null,
    payload: { id: transferId, status: 'pending', amount: '10.00', ...input.payload },
    metadata: {},
  };
}

export const depositPayload = (amount = '10.00', currency = 'USD') => ({
  operationId: randomUUID(),
  amount,
  currency,
  postings: [],
});
