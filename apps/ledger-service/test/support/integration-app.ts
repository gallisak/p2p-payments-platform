import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { EmailNormalizationModule } from '../../src/auth/email-normalization.module';
import { WalletsModule } from '../../src/wallets/wallets.module';
import { InternalModule } from '../../src/internal/internal.module';
import { AdminModule } from '../../src/admin/admin.module';
import { INTERNAL_API_KEY_HEADER } from '../../src/internal/internal-api-key.guard';
import { User } from '../../src/auth/entities/user.entity';
import { Wallet } from '../../src/wallets/entities/wallet.entity';
import { Hold } from '../../src/wallets/entities/hold.entity';
import { LedgerEvent } from '../../src/ledger/entities/ledger-event.entity';
import { LedgerEntry } from '../../src/ledger/entities/ledger-entry.entity';
import { OutboxMessage } from '../../src/outbox/outbox-message.entity';
import { EventEnvelope } from '../../src/outbox/event-envelope';

process.env.JWT_ACCESS_SECRET ??= 'int-access';
process.env.JWT_REFRESH_SECRET ??= 'int-refresh';
process.env.INTERNAL_API_KEY ??= 'int-internal-key';
process.env.ADMIN_EMAIL ??= 'admin@example.com';
process.env.ADMIN_PASSWORD ??= 'admin-password';
process.env.REDIS_URL ??= 'redis://localhost:6379';

export const testDatabase = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5433),
  username: process.env.DATABASE_USER ?? 'ledger',
  password: process.env.DATABASE_PASSWORD ?? 'ledger',
  database: process.env.TEST_DATABASE_NAME ?? 'ledger_test',
};

if (!/test/i.test(testDatabase.database)) {
  throw new Error(
    `Integration tests drop the schema of "${testDatabase.database}"; use a database whose name contains "test"`,
  );
}

export interface PublishedEvent {
  id: string;
  eventId: string;
  type: string;
  envelope: EventEnvelope;
}

export interface IntegrationApp {
  app: INestApplication;
  redis: Redis;
  stream: string;
  published: () => Promise<PublishedEvent[]>;
  close: () => Promise<void>;
  dataSource: DataSource;
  http: () => ReturnType<typeof request>;
  internal: (
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) => request.Test;
  registerUser: () => Promise<{ token: string; userId: string }>;
  adminToken: () => Promise<string>;
  openWallet: (token: string, currency?: string) => Promise<string>;
}

export async function createIntegrationApp(
  options: { relay?: boolean } = {},
): Promise<IntegrationApp> {
  const stream = `test.ledger.events.${randomUUID()}`;
  process.env.OUTBOX_STREAM = stream;
  process.env.OUTBOX_POLL_MS = '20';
  process.env.OUTBOX_RELAY_ENABLED = options.relay === false ? 'false' : 'true';
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        ...testDatabase,
        entities: [User, Wallet, Hold, LedgerEvent, LedgerEntry, OutboxMessage],
        synchronize: true,
        dropSchema: true,
      }),
      AuthModule,
      EmailNormalizationModule,
      WalletsModule,
      InternalModule,
      AdminModule,
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  const dataSource = moduleRef.get(DataSource);
  const http = () => request(app.getHttpServer());
  const internal = (method: 'get' | 'post', path: string, body?: object) => {
    const req = http()[method](`/internal${path}`).set(
      INTERNAL_API_KEY_HEADER,
      process.env.INTERNAL_API_KEY as string,
    );
    return body ? req.send(body) : req;
  };

  let counter = 0;
  const registerUser = async () => {
    const email = `user-${++counter}-${Date.now()}@example.com`;
    const res = await http()
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    const user = await dataSource.getRepository(User).findOneByOrFail({ email });
    return { token: res.body.accessToken as string, userId: user.id };
  };

  const adminToken = async () => {
    const res = await http()
      .post('/auth/login')
      .send({
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      })
      .expect(201);
    return res.body.accessToken as string;
  };

  const openWallet = async (token: string, currency = 'USD') => {
    const res = await http()
      .post('/wallets')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency })
      .expect(201);
    return res.body.id as string;
  };

  const redis = new Redis(process.env.REDIS_URL as string);
  const published = async (): Promise<PublishedEvent[]> => {
    const entries = await redis.xrange(stream, '-', '+');
    return entries.map(([id, fields]) => {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
      return {
        id,
        eventId: map.get('eventId') as string,
        type: map.get('type') as string,
        envelope: JSON.parse(map.get('envelope') as string) as EventEnvelope,
      };
    });
  };
  const close = async () => {
    await app.close();
    await redis.del(stream);
    redis.disconnect();
  };

  return {
    app,
    redis,
    stream,
    published,
    close,
    dataSource,
    http,
    internal,
    registerUser,
    adminToken,
    openWallet,
  };
}
