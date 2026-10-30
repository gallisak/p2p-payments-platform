'use client';

import { useRealtime } from './realtime-provider';
import { Amount, Empty, Row, RowList } from './row-list';
import { Badge } from '@/components/ui/badge';
import { STATUS_TEXT, failureText } from '@/lib/transfer-text';
import { Transfer } from '@/lib/types';

const LIMIT = 10;

function StatusBadge({ status }: { status: string }) {
  const text = STATUS_TEXT[status] ?? status;
  if (status === 'failed') {
    return <Badge variant="destructive">{text}</Badge>;
  }
  return (
    <Badge variant="outline" className={status === 'completed' ? 'border-success text-success' : undefined}>
      {text}
    </Badge>
  );
}

export function LiveTransfers({ initial }: { initial: Transfer[] }) {
  const { transfers: live } = useRealtime();
  const merged = new Map(initial.map((t) => [t.id, t]));
  for (const { transfer } of Object.values(live)) {
    merged.set(transfer.id, transfer);
  }
  const transfers = [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, LIMIT);

  if (transfers.length === 0) {
    return <Empty>No transfers yet.</Empty>;
  }
  return (
    <RowList>
      {transfers.map((t) => (
        <Row key={t.id}>
          <span>
            {t.recipientEmail}
            {t.status === 'failed' && <span className="block text-destructive">{failureText(t.failureReason)}</span>}
          </span>
          <span className="flex items-center gap-2">
            <Amount>
              {t.amount} {t.fromCurrency ?? ''}
            </Amount>
            <StatusBadge status={t.status} />
          </span>
        </Row>
      ))}
    </RowList>
  );
}
