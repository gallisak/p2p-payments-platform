import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OutboxMessage } from './outbox-message.entity';
import { EventEnvelope } from './event-envelope';
import { LedgerEvent } from '../ledger/entities/ledger-event.entity';
import { Wallet } from '../wallets/entities/wallet.entity';

@Injectable()
export class OutboxWriter {
  async enqueue(
    manager: EntityManager,
    event: LedgerEvent,
    wallet: Wallet,
  ): Promise<void> {
    const envelope: EventEnvelope = {
      eventId: event.eventId,
      type: event.type,
      schemaVersion: event.schemaVersion,
      streamId: event.streamId,
      streamVersion: event.streamVersion,
      occurredAt: event.occurredAt.toISOString(),
      ownerId: wallet.ownerId,
      wallet: {
        currency: wallet.currency,
        balance: wallet.balance,
        held: wallet.held,
        blocked: wallet.blocked,
      },
      payload: event.payload,
      metadata: event.metadata,
    };
    await manager.save(OutboxMessage, {
      eventId: event.eventId,
      type: event.type,
      envelope,
      publishedAt: null,
      lastError: null,
    });
  }
}
