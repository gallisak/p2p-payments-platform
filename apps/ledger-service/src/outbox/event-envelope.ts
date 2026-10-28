export interface WalletSnapshot {
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
}

export interface EventEnvelope {
  eventId: string;
  type: string;
  schemaVersion: number;
  streamId: string;
  streamVersion: number;
  occurredAt: string;
  ownerId: string;
  wallet: WalletSnapshot;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
