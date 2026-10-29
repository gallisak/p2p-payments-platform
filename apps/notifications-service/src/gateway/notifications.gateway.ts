import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { corsOrigin } from '../common/cors';
import { requireEnv } from '../common/env';
import { NotificationsStore, Applied } from '../store/notifications.store';
import { activityView } from '../store/views';

const MAX_TIMER_MS = 2_147_483_647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SocketData {
  userId?: string;
  expiryTimer?: NodeJS.Timeout;
}

export const userRoom = (userId: string) => `user:${userId}`;

function tokenOf(client: Socket): string | null {
  const fromAuth = (client.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth.replace(/^Bearer\s+/i, '');
  }
  const header = client.handshake.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '');
  }
  return null;
}

@WebSocketGateway({ cors: { origin: corsOrigin } })
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);
  private readonly secret = requireEnv('JWT_ACCESS_SECRET');

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly store: NotificationsStore,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const data = client.data as SocketData;
    const token = tokenOf(client);
    let payload: { sub?: unknown; exp?: unknown };
    try {
      if (!token) {
        throw new Error('missing token');
      }
      payload = await this.jwt.verifyAsync(token, { secret: this.secret });
      if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) {
        throw new Error('invalid subject');
      }
    } catch {
      client.emit('unauthorized', { message: 'Потрібен дійсний access token' });
      client.disconnect(true);
      return;
    }
    const userId = payload.sub.toLowerCase();
    data.userId = userId;
    if (typeof payload.exp === 'number') {
      const ms = Math.min(Math.max(payload.exp * 1000 - Date.now(), 0), MAX_TIMER_MS);
      data.expiryTimer = setTimeout(() => {
        client.emit('session.expired', { message: 'Access token сплив, перепідключіться з новим' });
        client.disconnect(true);
      }, ms);
      data.expiryTimer.unref();
    }
    if (client.disconnected) {
      this.handleDisconnect(client);
      return;
    }
    await client.join(userRoom(userId));
    try {
      client.emit('snapshot', await this.store.snapshot(userId));
    } catch (err) {
      this.logger.warn(`Snapshot for ${userId} failed: ${(err as Error).message}`);
      client.emit('snapshot.failed', { message: 'Не вдалося отримати поточний стан, спробуйте ще раз' });
    }
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as SocketData;
    if (data.expiryTimer) {
      clearTimeout(data.expiryTimer);
    }
  }

  @SubscribeMessage('snapshot')
  async resync(@ConnectedSocket() client: Socket) {
    const userId = (client.data as SocketData).userId;
    if (!userId) {
      return { error: 'unauthorized' };
    }
    return this.store.snapshot(userId);
  }

  publish(applied: Applied): void {
    if (!this.server) {
      return;
    }
    if (applied.wallet) {
      const { ownerId, occurredAt, ...wallet } = applied.wallet;
      this.server
        .to(userRoom(ownerId))
        .emit('wallet.updated', { ...wallet, occurredAt: occurredAt.toISOString() });
    }
    if (applied.transfer) {
      const t = applied.transfer;
      this.server.to(userRoom(t.ownerId)).emit('transfer.updated', {
        transferId: t.transferId,
        status: t.status,
        streamVersion: t.streamVersion,
        occurredAt: t.occurredAt.toISOString(),
        transfer: t.view,
      });
    }
    for (const activity of applied.activities) {
      this.server.to(userRoom(activity.userId)).emit('activity.created', activityView(activity));
    }
  }
}
