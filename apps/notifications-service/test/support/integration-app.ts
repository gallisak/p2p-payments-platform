import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { AddressInfo } from 'net';
import { Socket, io } from 'socket.io-client';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { EventsConsumer } from '../../src/consumer/events.consumer';
import { NOTIFICATIONS_ENTITIES, NotificationsModule } from '../../src/notifications.module';

process.env.JWT_ACCESS_SECRET ??= 'int-access';
process.env.REDIS_URL ??= 'redis://localhost:6379';

export const testDatabase = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5435),
  username: process.env.DATABASE_USER ?? 'notifications',
  password: process.env.DATABASE_PASSWORD ?? 'notifications',
  database: process.env.TEST_DATABASE_NAME ?? 'notifications_test',
};

if (!/test/i.test(testDatabase.database)) {
  throw new Error(
    `Integration tests drop the schema of "${testDatabase.database}"; use a database whose name contains "test"`,
  );
}

const DEFAULT_ENV: Record<string, string> = {
  CONSUMER_BLOCK_MS: '50',
  CONSUMER_RETRY_IDLE_MS: '10000',
  CONSUMER_RECLAIM_INTERVAL_MS: '600000',
  CONSUMER_MAX_DELIVERIES: '3',
  CORS_ORIGINS: 'http://localhost:3000',
};

export interface DeadLetter {
  stream: string;
  id: string;
  reason: string;
  deliveries: string;
  fields: string;
}

export interface NotificationsApp {
  app: INestApplication;
  url: string;
  dataSource: DataSource;
  redis: Redis;
  consumer: EventsConsumer;
  streams: { ledger: string; payments: string; deadLetter: string };
  http: () => ReturnType<typeof request>;
  token: (userId: string, expiresIn?: string | number) => Promise<string>;
  publish: (source: 'ledger' | 'payments', envelope: object | string) => Promise<string>;
  connect: (token: string | null) => Socket;
  deadLetters: () => Promise<DeadLetter[]>;
  until: <T>(probe: () => Promise<T | undefined>, timeoutMs?: number) => Promise<T>;
  close: () => Promise<void>;
}

export async function createNotificationsApp(
  env: Record<string, string> = {},
  options: { beforeStart?: (ctx: { redis: Redis; streams: NotificationsApp['streams'] }) => Promise<void> } = {},
): Promise<NotificationsApp> {
  const suffix = randomUUID();
  const streams = {
    ledger: `test.ledger.events.${suffix}`,
    payments: `test.payments.events.${suffix}`,
    deadLetter: `test.notifications.dead.${suffix}`,
  };
  const redis = new Redis(process.env.REDIS_URL as string);
  await options.beforeStart?.({ redis, streams });
  const applied = {
    ...DEFAULT_ENV,
    ...env,
    LEDGER_EVENTS_STREAM: streams.ledger,
    PAYMENTS_EVENTS_STREAM: streams.payments,
    DEAD_LETTER_STREAM: streams.deadLetter,
    CONSUMER_NAME: `test-${suffix}`,
  };
  const previous = Object.fromEntries(Object.keys(applied).map((k) => [k, process.env[k]]));
  Object.assign(process.env, applied);

  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        ...testDatabase,
        entities: NOTIFICATIONS_ENTITIES,
        synchronize: true,
        dropSchema: true,
      }),
      NotificationsModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
  const sockets: Socket[] = [];

  const until = async <T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('Condition was not met in time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return {
    app,
    url,
    dataSource: moduleRef.get(DataSource),
    redis,
    consumer: moduleRef.get(EventsConsumer),
    streams,
    http: () => request(app.getHttpServer()),
    token: (userId, expiresIn = '15m') =>
      jwt.signAsync({ sub: userId, email: `${userId}@example.com`, role: 'user' }, { expiresIn }),
    publish: (source, envelope) =>
      redis.xadd(
        streams[source],
        '*',
        'eventId',
        typeof envelope === 'string' ? 'x' : String((envelope as { eventId?: string }).eventId),
        'type',
        typeof envelope === 'string' ? 'x' : String((envelope as { type?: string }).type),
        'envelope',
        typeof envelope === 'string' ? envelope : JSON.stringify(envelope),
      ) as Promise<string>,
    connect: (token) => {
      const socket = io(url, {
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      return socket;
    },
    deadLetters: async () => {
      const entries = await redis.xrange(streams.deadLetter, '-', '+');
      return entries.map(([, fields]) => {
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) map[fields[i]] = fields[i + 1];
        return map as unknown as DeadLetter;
      });
    },
    until,
    close: async () => {
      sockets.forEach((s) => s.disconnect());
      await app.close();
      await redis.del(streams.ledger, streams.payments, streams.deadLetter);
      redis.disconnect();
    },
  };
}

export function nextEvent<T = Record<string, unknown>>(
  socket: Socket,
  event: string,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No "${event}" within ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function collect<T = Record<string, unknown>>(socket: Socket, event: string): T[] {
  const items: T[] = [];
  socket.on(event, (payload: T) => items.push(payload));
  return items;
}
