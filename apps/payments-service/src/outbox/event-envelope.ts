export interface EventEnvelope {
  eventId: string;
  type: string;
  schemaVersion: number;
  streamId: string;
  streamVersion: number;
  occurredAt: string;
  ownerId: string;
  recipientId: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
