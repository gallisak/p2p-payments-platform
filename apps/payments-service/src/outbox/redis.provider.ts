import Redis from 'ioredis';

export const OUTBOX_REDIS = Symbol('OUTBOX_REDIS');

export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
}

export function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set');
  }
  return url;
}
