'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Socket, io } from 'socket.io-client';
import {
  EMPTY_STATE,
  LiveTransfer,
  LiveWallet,
  RealtimeState,
  Snapshot,
  withActivity,
  withSnapshot,
  withTransfer,
  withWallet,
} from '@/lib/realtime-state';
import { ActivityItem } from '@/lib/types';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

interface Realtime extends RealtimeState {
  status: ConnectionStatus;
}

const RealtimeContext = createContext<Realtime>({ ...EMPTY_STATE, status: 'connecting' });

const RECONNECT_DELAY_MS = 1_000;
const RESYNC_DELAY_MS = 2_000;

export const useRealtime = () => useContext(RealtimeContext);

async function freshToken(): Promise<string | undefined> {
  const res = await fetch('/api/ws-token', { cache: 'no-store' });
  if (res.status === 401) {
    window.location.assign('/login');
  }
  return res.ok ? ((await res.json()) as { token: string }).token : undefined;
}

export function RealtimeProvider({ url, children }: { url: string; children: React.ReactNode }) {
  const [state, setState] = useState<RealtimeState>(EMPTY_STATE);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let resyncTimer: ReturnType<typeof setTimeout> | undefined;
    const socket: Socket = io(url, {
      transports: ['websocket'],
      auth: (cb) => {
        freshToken()
          .then((token) => cb({ token }))
          .catch(() => cb({}));
      },
    });
    const applySnapshot = (snapshot: Snapshot) => setState((s) => withSnapshot(s, snapshot));

    socket.on('connect', () => setStatus('online'));
    socket.on('connect_error', () => setStatus('offline'));
    socket.on('disconnect', (reason) => {
      setStatus('offline');
      if (reason === 'io server disconnect') {
        reconnectTimer = setTimeout(() => socket.connect(), RECONNECT_DELAY_MS);
      }
    });
    socket.on('snapshot', applySnapshot);
    socket.on('snapshot.failed', () => {
      resyncTimer = setTimeout(() => socket.emit('snapshot', applySnapshot), RESYNC_DELAY_MS);
    });
    socket.on('wallet.updated', (wallet: LiveWallet) => setState((s) => withWallet(s, wallet)));
    socket.on('transfer.updated', (transfer: LiveTransfer) => setState((s) => withTransfer(s, transfer)));
    socket.on('activity.created', (item: ActivityItem) => setState((s) => withActivity(s, [item])));

    return () => {
      clearTimeout(reconnectTimer);
      clearTimeout(resyncTimer);
      socket.disconnect();
    };
  }, [url]);

  return <RealtimeContext.Provider value={{ ...state, status }}>{children}</RealtimeContext.Provider>;
}
