export type EventSource = 'ledger' | 'payments';

export interface WalletState {
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
}

export interface Envelope {
  eventId: string;
  type: string;
  schemaVersion: number;
  streamId: string;
  streamVersion: number;
  occurredAt: Date;
  ownerId: string;
  recipientId: string | null;
  wallet: WalletState | null;
  payload: Record<string, unknown>;
  traceparent?: unknown;
}

export class InvalidEnvelopeError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^-?\d+(\.\d{1,2})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new InvalidEnvelopeError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function wallet(value: unknown): WalletState {
  if (
    !isRecord(value) ||
    typeof value.currency !== 'string' ||
    typeof value.balance !== 'string' ||
    !AMOUNT_RE.test(value.balance) ||
    typeof value.held !== 'string' ||
    !AMOUNT_RE.test(value.held) ||
    typeof value.blocked !== 'boolean'
  ) {
    throw new InvalidEnvelopeError('wallet snapshot is malformed');
  }
  return {
    currency: value.currency,
    balance: value.balance,
    held: value.held,
    blocked: value.blocked,
  };
}

export function parseEnvelope(source: EventSource, raw: string | undefined): Envelope {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? '');
  } catch {
    throw new InvalidEnvelopeError('envelope is not valid JSON');
  }
  if (!isRecord(data)) {
    throw new InvalidEnvelopeError('envelope must be an object');
  }
  if (typeof data.type !== 'string' || data.type.length === 0 || data.type.length > 64) {
    throw new InvalidEnvelopeError('type must be a non-empty string');
  }
  if (!Number.isInteger(data.schemaVersion) || (data.schemaVersion as number) < 1) {
    throw new InvalidEnvelopeError('schemaVersion must be a positive integer');
  }
  if (!Number.isSafeInteger(data.streamVersion) || (data.streamVersion as number) < 1) {
    throw new InvalidEnvelopeError('streamVersion must be a positive integer');
  }
  const occurredAt = typeof data.occurredAt === 'string' ? new Date(data.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw new InvalidEnvelopeError('occurredAt must be an ISO date');
  }
  if (!isRecord(data.payload)) {
    throw new InvalidEnvelopeError('payload must be an object');
  }
  return {
    eventId: uuid(data.eventId, 'eventId'),
    type: data.type,
    schemaVersion: data.schemaVersion as number,
    streamId: uuid(data.streamId, 'streamId'),
    streamVersion: data.streamVersion as number,
    occurredAt,
    ownerId: uuid(data.ownerId, 'ownerId'),
    recipientId:
      data.recipientId === undefined || data.recipientId === null
        ? null
        : uuid(data.recipientId, 'recipientId'),
    wallet: source === 'ledger' ? wallet(data.wallet) : null,
    payload: data.payload,
    traceparent: isRecord(data.metadata) ? data.metadata.traceparent : undefined,
  };
}
