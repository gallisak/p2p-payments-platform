import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { SplitBill } from './entities/split-bill.entity';
import { SplitShare } from './entities/split-share.entity';
import { billStatus } from './allocation';
import { shareView } from './split-bill-view';
import { OutboxWriter, SPLIT_BILL_EVENT_SCHEMA_VERSION, SplitBillEventType } from '../outbox/outbox.writer';
import { Transfer } from '../transfers/entities/transfer.entity';

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

  async linkPayment(
    manager: EntityManager,
    target: { billId: string; shareId: string },
    participantId: string,
    transferId: string,
  ): Promise<void> {
    const { bill, share } = await this.lock(manager, target.billId, target.shareId);
    if (!bill || !share || share.participantId !== participantId) {
      throw new NotFoundException('Share not found');
    }
    if (share.status === 'paid') {
      throw new ConflictException('The share is already paid');
    }
    if (share.status === 'paying') {
      throw new ConflictException('Payment for this share is already in progress');
    }
    share.status = 'paying';
    share.transferId = transferId;
    await manager.save(share);
  }

  async onTransferSettled(manager: EntityManager, transfer: Transfer): Promise<void> {
    if (!transfer.splitShareId || (transfer.status !== 'completed' && transfer.status !== 'failed')) {
      return;
    }
    const known = await manager.findOne(SplitShare, { where: { id: transfer.splitShareId } });
    if (!known) {
      return;
    }
    const { bill, share } = await this.lock(manager, known.billId, known.id);
    if (!bill || !share || share.transferId !== transfer.id || share.status !== 'paying') {
      return;
    }
    if (transfer.status === 'failed') {
      share.status = 'pending';
      share.transferId = null;
      await manager.save(share);
      return;
    }
    share.status = 'paid';
    share.paidAt = transfer.completedAt ?? new Date();
    await manager.save(share);

    const shares = await manager.find(SplitShare, { where: { billId: bill.id } });
    bill.status = billStatus(shares);
    bill.settledAt = bill.status === 'settled' ? share.paidAt : null;
    bill.version += 1;
    await manager.save(bill);
    await this.emit(manager, 'SplitSharePaid', bill, { bill: billSummary(bill), share: shareView(share) });
    if (bill.status === 'settled') {
      bill.version += 1;
      await manager.save(bill);
      await this.emit(manager, 'SplitBillSettled', bill, { bill: billSummary(bill) });
    }
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
