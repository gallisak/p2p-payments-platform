import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EntityManager } from 'typeorm';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerEvent } from './entities/ledger-event.entity';
import {
  CURRENT_SCHEMA_VERSION,
  LedgerEventPayloads,
  LedgerEventType,
  Posting,
  assertBalanced,
} from './ledger-events';

export interface AppendInput<T extends LedgerEventType> {
  streamId: string;
  expectedVersion: number;
  type: T;
  payload: LedgerEventPayloads[T];
  metadata?: Record<string, unknown>;
}

@Injectable()
export class EventStore {
  async append<T extends LedgerEventType>(
    manager: EntityManager,
    input: AppendInput<T>,
  ): Promise<LedgerEvent> {
    const { postings, operationId } = input.payload as {
      postings?: Posting[];
      operationId?: string;
    };
    if (postings) {
      if (!operationId) {
        throw new Error(`${input.type} has postings but no operationId`);
      }
      assertBalanced(postings);
    }

    const event = await manager.save(
      manager.create(LedgerEvent, {
        eventId: randomUUID(),
        streamId: input.streamId,
        streamVersion: input.expectedVersion + 1,
        type: input.type,
        schemaVersion: CURRENT_SCHEMA_VERSION[input.type],
        payload: input.payload as unknown as Record<string, unknown>,
        metadata: input.metadata ?? {},
      }),
    );

    if (postings) {
      await manager.insert(
        LedgerEntry,
        postings.map((posting) => ({
          operationId,
          eventId: event.eventId,
          accountId: posting.accountId,
          currency: posting.currency,
          amount: posting.amount,
        })),
      );
    }

    return event;
  }

  async readStream(
    manager: EntityManager,
    streamId: string,
  ): Promise<LedgerEvent[]> {
    return manager.find(LedgerEvent, {
      where: { streamId },
      order: { streamVersion: 'ASC' },
    });
  }
}
