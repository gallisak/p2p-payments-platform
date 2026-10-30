'use client';

import { useRealtime } from './realtime-provider';
import { Amount, Empty, Row, RowList } from './row-list';
import { Badge } from '@/components/ui/badge';
import { Wallet } from '@/lib/types';

export function LiveWallets({ initial }: { initial: Wallet[] }) {
  const { wallets: live } = useRealtime();
  const known = new Set(initial.map((w) => w.id));
  const wallets: Wallet[] = [
    ...initial.map((w) => {
      const update = live[w.id];
      return update ? { ...w, balance: update.balance, held: update.held, blocked: update.blocked } : w;
    }),
    ...Object.values(live)
      .filter((w) => !known.has(w.walletId))
      .map(({ walletId, currency, balance, held, blocked }) => ({ id: walletId, currency, balance, held, blocked })),
  ];

  if (wallets.length === 0) {
    return <Empty>No wallets yet.</Empty>;
  }
  return (
    <RowList>
      {wallets.map((w) => (
        <Row key={w.id}>
          <span className="flex items-center gap-2">
            {w.currency}
            {w.blocked && <Badge variant="destructive">Blocked</Badge>}
          </span>
          <span>
            <Amount>{w.balance}</Amount>
            {w.held !== '0.00' && <span className="text-muted-foreground"> ({w.held} held)</span>}
          </span>
        </Row>
      ))}
    </RowList>
  );
}
