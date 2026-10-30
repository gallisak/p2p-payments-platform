import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Redis from 'ioredis';
import { DataSource, In, IsNull } from 'typeorm';
import { OutboxMessage } from './outbox-message.entity';
import { OUTBOX_REDIS } from './redis.provider';
import { outboxPublished } from '../telemetry/metrics';

const RELAY_LOCK_KEY = 7_340_102;
const MAX_BACKOFF_MS = 5_000;
const PURGE_BATCH = 1_000;
const MAX_PURGE_BATCHES_PER_RUN = 50;

export interface RelayOptions {
  stream: string;
  batchSize: number;
  pollMs: number;
  maxLen: number;
  retentionMs: number;
  cleanupEveryMs: number;
}

export function relayOptionsFromEnv(): RelayOptions {
  return {
    stream: process.env.OUTBOX_STREAM ?? 'payments.events',
    batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 100),
    pollMs: Number(process.env.OUTBOX_POLL_MS ?? 200),
    maxLen: Number(process.env.OUTBOX_STREAM_MAXLEN ?? 100_000),
    retentionMs: Number(process.env.OUTBOX_RETENTION_HOURS ?? 24) * 3_600_000,
    cleanupEveryMs: Number(process.env.OUTBOX_CLEANUP_INTERVAL_MS ?? 60_000),
  };
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly options = relayOptionsFromEnv();
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private redisHealthy = true;
  private lastCleanup = 0;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OUTBOX_REDIS) private readonly redis: Redis,
  ) {
    this.redis.on('error', (err: Error) => {
      if (this.redisHealthy) {
        this.redisHealthy = false;
        this.logger.warn(`Lost connection to Redis: ${err.message}`);
      }
    });
    this.redis.on('ready', () => {
      if (!this.redisHealthy) {
        this.logger.log('Reconnected to Redis');
      }
      this.redisHealthy = true;
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureConnected().catch(() => undefined);
    if (process.env.OUTBOX_RELAY_ENABLED === 'false') {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    if (this.redis.status !== 'end') {
      this.redis.disconnect();
    }
  }

  async publishPending(): Promise<number> {
    await this.ensureConnected();
    const claimed = await this.dataSource.transaction(async (manager) => {
      const [{ locked }] = await manager.query(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [RELAY_LOCK_KEY],
      );
      if (!locked) {
        return [] as OutboxMessage[];
      }
      const unpublished = await manager.find(OutboxMessage, {
        where: { publishedAt: IsNull() },
        order: { id: 'ASC' },
        take: this.options.batchSize,
      });
      if (unpublished.length === 0) {
        return [];
      }
      await this.publish(unpublished);
      await manager.update(
        OutboxMessage,
        { id: In(unpublished.map((m) => m.id)) },
        { publishedAt: () => 'now()' },
      );
      return unpublished;
    });
    outboxPublished.inc(claimed.length);
    return claimed.length;
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'ready') {
      return;
    }
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
      return;
    }
    throw new Error(`Redis is not connected (${this.redis.status})`);
  }

  async purgePublished(olderThanMs = this.options.retentionMs): Promise<number> {
    const [{ count }]: { count: number }[] = await this.dataSource.query(
      `WITH deleted AS (
         DELETE FROM outbox
          WHERE id IN (
            SELECT id FROM outbox
             WHERE "publishedAt" IS NOT NULL
               AND "publishedAt" < now() - make_interval(secs => $1)
             ORDER BY id
             LIMIT $2)
         RETURNING id)
       SELECT count(*)::int AS count FROM deleted`,
      [olderThanMs / 1000, PURGE_BATCH],
    );
    return count;
  }

  private async publish(messages: OutboxMessage[]): Promise<void> {
    const batch = this.redis.multi();
    for (const message of messages) {
      batch.xadd(
        this.options.stream,
        'MAXLEN',
        '~',
        this.options.maxLen,
        '*',
        'eventId',
        message.eventId,
        'type',
        message.type,
        'envelope',
        JSON.stringify(message.envelope),
      );
    }
    const results = await batch.exec();
    const failed = (results ?? []).find(([err]) => err);
    if (!results || failed) {
      throw failed?.[0] ?? new Error('Redis transaction was aborted');
    }
  }

  private async run(): Promise<void> {
    let backoff = this.options.pollMs;
    while (this.running) {
      try {
        const published = await this.publishPending();
        backoff = this.options.pollMs;
        await this.cleanupIfDue();
        if (published > 0) {
          continue;
        }
      } catch (err) {
        await this.recordFailure(err as Error);
        this.logger.warn(`Outbox publish failed, retrying in ${backoff} ms: ${(err as Error).message}`);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
      await this.sleep(backoff);
    }
  }

  private async cleanupIfDue(): Promise<void> {
    if (Date.now() - this.lastCleanup < this.options.cleanupEveryMs) {
      return;
    }
    this.lastCleanup = Date.now();
    try {
      for (let i = 0; i < MAX_PURGE_BATCHES_PER_RUN; i++) {
        if ((await this.purgePublished()) < PURGE_BATCH) {
          return;
        }
      }
    } catch (err) {
      this.logger.warn(`Outbox cleanup failed: ${(err as Error).message}`);
    }
  }

  private async recordFailure(err: Error): Promise<void> {
    await this.dataSource
      .query(
        `UPDATE outbox SET attempts = attempts + 1, "lastError" = $1
          WHERE id IN (SELECT id FROM outbox WHERE "publishedAt" IS NULL ORDER BY id LIMIT $2)`,
        [err.message.slice(0, 500), this.options.batchSize],
      )
      .catch(() => undefined);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
