import { Activity } from './entities/activity.entity';
import { TransferSnapshot } from './entities/transfer-snapshot.entity';
import { WalletSnapshot } from './entities/wallet-snapshot.entity';

export function walletView(w: WalletSnapshot) {
  return {
    walletId: w.walletId,
    currency: w.currency,
    balance: w.balance,
    held: w.held,
    blocked: w.blocked,
    streamVersion: w.streamVersion,
    occurredAt: w.occurredAt.toISOString(),
  };
}

export function transferSnapshotView(t: TransferSnapshot) {
  return {
    transferId: t.transferId,
    status: t.status,
    streamVersion: t.streamVersion,
    occurredAt: t.occurredAt.toISOString(),
    transfer: t.view,
  };
}

export function activityView(a: Activity) {
  return {
    id: a.id,
    type: a.type,
    occurredAt: a.occurredAt.toISOString(),
    data: a.data,
  };
}
