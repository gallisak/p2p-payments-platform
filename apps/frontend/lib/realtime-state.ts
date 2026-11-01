import { ActivityItem, Transfer, Wallet } from './types';

export interface LiveWallet {
  walletId: string;
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
  streamVersion: number;
}

export interface LiveTransfer {
  transferId: string;
  status: string;
  streamVersion: number;
  transfer: Transfer;
}

export interface Snapshot {
  wallets: LiveWallet[];
  transfers: LiveTransfer[];
  activity: ActivityItem[];
}

export interface RealtimeState {
  wallets: Record<string, LiveWallet>;
  transfers: Record<string, LiveTransfer>;
  activity: ActivityItem[];
}

export const EMPTY_STATE: RealtimeState = { wallets: {}, transfers: {}, activity: [] };

const MAX_ACTIVITY = 100;

function newer<T extends { streamVersion: number }>(current: T | undefined, incoming: T): T {
  return current && current.streamVersion >= incoming.streamVersion ? current : incoming;
}

export function latestWallet(wallet: Wallet, live: LiveWallet | undefined): Wallet {
  if (!live || live.streamVersion < wallet.version) {
    return wallet;
  }
  const { balance, held, blocked, streamVersion } = live;
  return { ...wallet, balance, held, blocked, version: streamVersion };
}

export function latestTransfer(transfer: Transfer, live: LiveTransfer | undefined): Transfer {
  return live && live.transfer.updatedAt >= transfer.updatedAt ? live.transfer : transfer;
}

export function withWallet(state: RealtimeState, wallet: LiveWallet): RealtimeState {
  return {
    ...state,
    wallets: { ...state.wallets, [wallet.walletId]: newer(state.wallets[wallet.walletId], wallet) },
  };
}

export function withTransfer(state: RealtimeState, transfer: LiveTransfer): RealtimeState {
  return {
    ...state,
    transfers: { ...state.transfers, [transfer.transferId]: newer(state.transfers[transfer.transferId], transfer) },
  };
}

export function withActivity(state: RealtimeState, items: ActivityItem[]): RealtimeState {
  const merged = new Map([...items, ...state.activity].map((item) => [item.id, item]));
  const activity = [...merged.values()]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, MAX_ACTIVITY);
  return { ...state, activity };
}

export function withSnapshot(state: RealtimeState, snapshot: Snapshot): RealtimeState {
  const wallets = snapshot.wallets.reduce(withWallet, state);
  const transfers = snapshot.transfers.reduce(withTransfer, wallets);
  return withActivity(transfers, snapshot.activity);
}
