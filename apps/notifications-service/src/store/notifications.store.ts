import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { Activity } from './entities/activity.entity';
import { TransferSnapshot } from './entities/transfer-snapshot.entity';
import { WalletSnapshot } from './entities/wallet-snapshot.entity';
import { activityView, transferSnapshotView, walletView } from './views';
import { ActivityType } from '../events/activity-types';
import { Effects, TransferUpdate, WalletUpdate } from '../events/effects';
import { EventSource } from '../events/envelope';

const TERMINAL_TRANSFER_STATUSES = ['completed', 'failed'];
const SNAPSHOT_RECENT = 20;
const SNAPSHOT_ACTIVE_LIMIT = 50;
const PURGE_BATCH = 1_000;
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export interface Applied {
  duplicate: boolean;
  wallet: WalletUpdate | null;
  transfer: TransferUpdate | null;
  activities: Activity[];
}

export interface ActivityPage {
  items: ReturnType<typeof activityView>[];
  nextCursor: string | null;
}

export class InvalidCursorError extends Error {}

export function encodeCursor(a: { occurredAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([a.occurredAt.toISOString(), a.id])).toString('base64url');
}

export function decodeCursor(cursor: string): { occurredAt: Date; id: string } {
  try {
    const [occurredAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    const date = new Date(occurredAt as string);
    if (
      typeof occurredAt !== 'string' ||
      Number.isNaN(date.getTime()) ||
      typeof id !== 'string' ||
      !/^\d{1,19}$/.test(id) ||
      BigInt(id) > MAX_BIGINT
    ) {
      throw new Error();
    }
    return { occurredAt: date, id };
  } catch {
    throw new InvalidCursorError('Невалідний cursor');
  }
}

@Injectable()
export class NotificationsStore {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async apply(source: EventSource, eventId: string, effects: Effects): Promise<Applied> {
    return this.dataSource.transaction(async (manager) => {
      const fresh: unknown[] = await manager.query(
        `WITH inserted AS (
           INSERT INTO processed_events ("eventId", source) VALUES ($1, $2)
           ON CONFLICT ("eventId") DO NOTHING
           RETURNING "eventId")
         SELECT "eventId" FROM inserted`,
        [eventId, source],
      );
      if (fresh.length === 0) {
        return { duplicate: true, wallet: null, transfer: null, activities: [] };
      }
      const wallet = effects.wallet && (await this.applyWallet(manager, effects.wallet));
      const transfer = effects.transfer && (await this.applyTransfer(manager, effects.transfer));
      const activities: Activity[] = [];
      for (const input of effects.activities) {
        const rows: { id: string }[] = await manager.query(
          `WITH inserted AS (
             INSERT INTO activity ("userId", type, "eventId", "occurredAt", data)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT ("eventId", "userId") DO NOTHING
             RETURNING id)
           SELECT id::text AS id FROM inserted`,
          [input.userId, input.type, eventId, input.occurredAt, JSON.stringify(input.data)],
        );
        if (rows.length > 0) {
          activities.push(
            Object.assign(new Activity(), { ...input, id: rows[0].id, eventId }),
          );
        }
      }
      return { duplicate: false, wallet, transfer, activities };
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(userId: string) {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      const wallets = await manager.getRepository(WalletSnapshot).find({
        where: { ownerId: userId },
        order: { currency: 'ASC', walletId: 'ASC' },
      });
      const active = await manager.getRepository(TransferSnapshot).find({
        where: { ownerId: userId, status: Not(In(TERMINAL_TRANSFER_STATUSES)) },
        order: { occurredAt: 'DESC' },
        take: SNAPSHOT_ACTIVE_LIMIT,
      });
      const recent = await manager.getRepository(TransferSnapshot).find({
        where: { ownerId: userId },
        order: { occurredAt: 'DESC' },
        take: SNAPSHOT_RECENT,
      });
      const activity = await this.activity(userId, { limit: SNAPSHOT_RECENT }, manager);
      const transfers = new Map<string, TransferSnapshot>();
      for (const t of [...active, ...recent]) {
        transfers.set(t.transferId, t);
      }
      return {
        wallets: wallets.map(walletView),
        transfers: [...transfers.values()]
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
          .map(transferSnapshotView),
        activity: activity.items,
        activityCursor: activity.nextCursor,
        generatedAt: new Date().toISOString(),
      };
    });
  }

  async activity(
    userId: string,
    options: { types?: ActivityType[]; cursor?: string; limit: number },
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ActivityPage> {
    const qb = manager
      .getRepository(Activity)
      .createQueryBuilder('a')
      .where('a.userId = :userId', { userId })
      .orderBy('a.occurredAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(options.limit + 1);
    if (options.types?.length) {
      qb.andWhere('a.type IN (:...types)', { types: options.types });
    }
    if (options.cursor) {
      const { occurredAt, id } = decodeCursor(options.cursor);
      qb.andWhere('(a.occurredAt, a.id) < (:occurredAt, CAST(:id AS bigint))', { occurredAt, id });
    }
    const rows = await qb.getMany();
    const page = rows.slice(0, options.limit);
    return {
      items: page.map(activityView),
      nextCursor: rows.length > options.limit ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async purgeProcessed(olderThanMs: number): Promise<number> {
    const [{ count }]: { count: number }[] = await this.dataSource.query(
      `WITH deleted AS (
         DELETE FROM processed_events
          WHERE "eventId" IN (
            SELECT "eventId" FROM processed_events
             WHERE "processedAt" < now() - make_interval(secs => $1)
             LIMIT $2)
         RETURNING 1)
       SELECT count(*)::int AS count FROM deleted`,
      [olderThanMs / 1000, PURGE_BATCH],
    );
    return count;
  }

  private async applyWallet(manager: EntityManager, w: WalletUpdate): Promise<WalletUpdate | null> {
    const rows: unknown[] = await manager.query(
      `WITH upserted AS (
         INSERT INTO wallet_snapshots ("walletId", "ownerId", currency, balance, held, blocked, "streamVersion", "occurredAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT ("walletId") DO UPDATE SET
           "ownerId" = EXCLUDED."ownerId",
           currency = EXCLUDED.currency,
           balance = EXCLUDED.balance,
           held = EXCLUDED.held,
           blocked = EXCLUDED.blocked,
           "streamVersion" = EXCLUDED."streamVersion",
           "occurredAt" = EXCLUDED."occurredAt"
         WHERE wallet_snapshots."streamVersion" < EXCLUDED."streamVersion"
         RETURNING 1)
       SELECT 1 FROM upserted`,
      [w.walletId, w.ownerId, w.currency, w.balance, w.held, w.blocked, w.streamVersion, w.occurredAt],
    );
    return rows.length > 0 ? w : null;
  }

  private async applyTransfer(
    manager: EntityManager,
    t: TransferUpdate,
  ): Promise<TransferUpdate | null> {
    const rows: unknown[] = await manager.query(
      `WITH upserted AS (
         INSERT INTO transfer_snapshots ("transferId", "ownerId", "recipientId", status, view, "streamVersion", "occurredAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("transferId") DO UPDATE SET
           "ownerId" = EXCLUDED."ownerId",
           "recipientId" = EXCLUDED."recipientId",
           status = EXCLUDED.status,
           view = EXCLUDED.view,
           "streamVersion" = EXCLUDED."streamVersion",
           "occurredAt" = EXCLUDED."occurredAt"
         WHERE transfer_snapshots."streamVersion" < EXCLUDED."streamVersion"
         RETURNING 1)
       SELECT 1 FROM upserted`,
      [t.transferId, t.ownerId, t.recipientId, t.status, JSON.stringify(t.view), t.streamVersion, t.occurredAt],
    );
    return rows.length > 0 ? t : null;
  }
}
