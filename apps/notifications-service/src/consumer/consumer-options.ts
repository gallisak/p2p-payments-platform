import { numberEnv } from '../common/env';
import { EventSource } from '../events/envelope';

export interface ConsumerOptions {
  streams: Record<EventSource, string>;
  group: string;
  consumer: string;
  deadLetterStream: string;
  deadLetterMaxLen: number;
  batchSize: number;
  blockMs: number;
  retryIdleMs: number;
  reclaimEveryMs: number;
  maxDeliveries: number;
  processedRetentionMs: number;
  purgeEveryMs: number;
}

export function consumerOptionsFromEnv(consumer: string): ConsumerOptions {
  return {
    streams: {
      ledger: process.env.LEDGER_EVENTS_STREAM ?? 'ledger.events',
      payments: process.env.PAYMENTS_EVENTS_STREAM ?? 'payments.events',
    },
    group: process.env.CONSUMER_GROUP ?? 'notifications',
    consumer,
    deadLetterStream: process.env.DEAD_LETTER_STREAM ?? 'notifications.dead-letter',
    deadLetterMaxLen: Math.max(1, numberEnv('DEAD_LETTER_MAXLEN', 100_000)),
    batchSize: Math.max(1, numberEnv('CONSUMER_BATCH_SIZE', 50)),
    blockMs: Math.max(1, numberEnv('CONSUMER_BLOCK_MS', 1_000)),
    retryIdleMs: numberEnv('CONSUMER_RETRY_IDLE_MS', 10_000),
    reclaimEveryMs: numberEnv('CONSUMER_RECLAIM_INTERVAL_MS', 5_000),
    maxDeliveries: Math.max(1, numberEnv('CONSUMER_MAX_DELIVERIES', 5)),
    processedRetentionMs: numberEnv('PROCESSED_EVENTS_RETENTION_HOURS', 24 * 7) * 3_600_000,
    purgeEveryMs: numberEnv('PROCESSED_EVENTS_PURGE_INTERVAL_MS', 3_600_000),
  };
}
