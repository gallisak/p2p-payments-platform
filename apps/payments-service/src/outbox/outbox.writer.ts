import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { OutboxMessage } from './outbox-message.entity';
import { EventEnvelope } from './event-envelope';
import { Transfer } from '../transfers/entities/transfer.entity';
import { transferView } from '../transfers/transfer-view';

export type TransferEventType =
  | 'TransferInitiated'
  | 'TransferStepChanged'
  | 'TransferCompleted'
  | 'TransferFailed';

export const TRANSFER_EVENT_SCHEMA_VERSION = 1;

@Injectable()
export class OutboxWriter {
  async enqueue(manager: EntityManager, type: TransferEventType, transfer: Transfer): Promise<void> {
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      type,
      schemaVersion: TRANSFER_EVENT_SCHEMA_VERSION,
      streamId: transfer.id,
      streamVersion: transfer.version,
      occurredAt: transfer.updatedAt.toISOString(),
      ownerId: transfer.senderId,
      recipientId: transfer.recipientId,
      payload: transferView(transfer),
      metadata: { actorId: transfer.senderId },
    };
    await manager.save(OutboxMessage, {
      eventId: envelope.eventId,
      type,
      envelope,
      publishedAt: null,
      lastError: null,
    });
  }
}

export function eventTypeFor(transfer: Transfer): TransferEventType {
  switch (transfer.status) {
    case 'completed':
      return 'TransferCompleted';
    case 'failed':
      return 'TransferFailed';
    default:
      return 'TransferStepChanged';
  }
}
