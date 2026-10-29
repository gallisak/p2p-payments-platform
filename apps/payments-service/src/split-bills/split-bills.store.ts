import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SplitBill } from './entities/split-bill.entity';
import { SplitShare } from './entities/split-share.entity';
import { OutboxWriter, SPLIT_BILL_EVENT_SCHEMA_VERSION, SplitBillEventType } from '../outbox/outbox.writer';

export function billSummary(b: SplitBill) {
  return {
    id: b.id,
    title: b.title,
    creatorId: b.creatorId,
    creatorEmail: b.creatorEmail,
    currency: b.currency,
    totalAmount: b.totalAmount,
    dueAt: b.dueAt.toISOString(),
    status: b.status,
  };
}

@Injectable()
export class SplitBillsStore {
  constructor(private readonly outbox: OutboxWriter) {}

  async lock(manager: EntityManager, billId: string, shareId: string) {
    const bill = await manager.findOne(SplitBill, {
      where: { id: billId },
      lock: { mode: 'pessimistic_write' },
    });
    const share = bill
      ? await manager.findOne(SplitShare, {
          where: { id: shareId, billId },
          lock: { mode: 'pessimistic_write' },
        })
      : null;
    return { bill, share };
  }

  async emit(
    manager: EntityManager,
    type: SplitBillEventType,
    bill: SplitBill,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.outbox.enqueueEnvelope(manager, {
      type,
      schemaVersion: SPLIT_BILL_EVENT_SCHEMA_VERSION,
      streamId: bill.id,
      streamVersion: bill.version,
      occurredAt: new Date().toISOString(),
      ownerId: bill.creatorId,
      recipientId: null,
      payload,
      metadata: { actorId: bill.creatorId },
    });
  }
}
