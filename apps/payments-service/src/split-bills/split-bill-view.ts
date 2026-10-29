import { SplitBill } from './entities/split-bill.entity';
import { SplitShare } from './entities/split-share.entity';

export function shareView(s: SplitShare) {
  return {
    id: s.id,
    participantId: s.participantId,
    participantEmail: s.participantEmail,
    amount: s.amount,
    status: s.status,
    transferId: s.transferId,
    paidAt: s.paidAt?.toISOString() ?? null,
    reminderCount: s.reminderCount,
  };
}

export function billView(b: SplitBill, shares: SplitShare[]) {
  return {
    id: b.id,
    title: b.title,
    creatorId: b.creatorId,
    creatorEmail: b.creatorEmail,
    currency: b.currency,
    totalAmount: b.totalAmount,
    creatorAmount: b.creatorAmount,
    split: b.splitMode,
    dueAt: b.dueAt.toISOString(),
    status: b.status,
    createdAt: b.createdAt.toISOString(),
    settledAt: b.settledAt?.toISOString() ?? null,
    shares: shares.map(shareView),
  };
}
