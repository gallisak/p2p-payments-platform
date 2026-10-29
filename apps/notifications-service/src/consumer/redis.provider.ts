import Redis from 'ioredis';

export const CONSUMER_REDIS = Symbol('CONSUMER_REDIS');

export function createConsumerRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
}
