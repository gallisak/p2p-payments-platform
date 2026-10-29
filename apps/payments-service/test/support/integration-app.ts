import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module';
import { TransfersModule } from '../../src/transfers/transfers.module';
import { Transfer } from '../../src/transfers/entities/transfer.entity';
import { SagaStep } from '../../src/transfers/entities/saga-step.entity';
import { OutboxMessage } from '../../src/outbox/outbox-message.entity';
import { SplitBill } from '../../src/split-bills/entities/split-bill.entity';
import { SplitShare } from '../../src/split-bills/entities/split-share.entity';
import { SplitBillsModule } from '../../src/split-bills/split-bills.module';
import { EventEnvelope } from '../../src/outbox/event-envelope';
import { SagaWorker } from '../../src/saga/saga.worker';
import { FakeLedger } from './fake-ledger';

process.env.JWT_ACCESS_SECRET ??= 'int-access';
process.env.INTERNAL_API_KEY ??= 'int-internal-key';
process.env.REDIS_URL ??= 'redis://localhost:6379';

export const testDatabase = {
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: Number(process.env.DATABASE_PORT ?? 5434),
  username: process.env.DATABASE_USER ?? 'payments',
  password: process.env.DATABASE_PASSWORD ?? 'payments',
  database: process.env.TEST_DATABASE_NAME ?? 'payments_test',
};

if (!/test/i.test(testDatabase.database)) {
  throw new Error(
    `Integration tests drop the schema of "${testDatabase.database}"; use a database whose name contains "test"`,
  );
}

const DEFAULT_ENV: Record<string, string> = {
  OUTBOX_POLL_MS: '20',
  SAGA_POLL_MS: '20',
  SAGA_RETRY_BASE_MS: '20',
  SAGA_RETRY_MAX_MS: '200',
  SAGA_MAX_STEP_ATTEMPTS: '5',
  SAGA_TIMEOUT_MS: '30000',
  SAGA_LEASE_MS: '2000',
  LEDGER_TIMEOUT_MS: '500',
  LEDGER_BREAKER_FAILURES: '5',
  LEDGER_BREAKER_OPEN_MS: '200',
  TRANSFER_RATE_LIMIT_MAX: '1000',
  TRANSFER_MAX_AMOUNT_USD: '10000',
  TRANSFER_DAILY_LIMIT_USD: '50000',
  TRANSFER_BLOCKED_RECIPIENTS: 'banned@example.com',
  FX_QUOTE_TTL_MS: '60000',
  SPLIT_REMINDERS_ENABLED: 'false',
};

export interface Account {
  token: string;
  userId: string;
  email: string;
  walletId: string;
}

export interface PublishedEvent {
  eventId: string;
  type: string;
  envelope: EventEnvelope;
}

export interface PaymentsApp {
  app: INestApplication;
  ledger: FakeLedger;
  dataSource: DataSource;
  worker: SagaWorker;
  http: () => ReturnType<typeof request>;
  account: (currency?: string, funds?: string) => Promise<Account>;
  transfer: (from: Account, body: object, key?: string) => request.Test;
  settle: (token: string, id: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitFor: (token: string, id: string, done: (t: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
  published: () => Promise<PublishedEvent[]>;
  close: () => Promise<void>;
}

export async function createPaymentsApp(env: Record<string, string> = {}): Promise<PaymentsApp> {
  const ledger = new FakeLedger(process.env.INTERNAL_API_KEY as string);
  const stream = `test.payments.events.${randomUUID()}`;
  const applied = { ...DEFAULT_ENV, ...env, OUTBOX_STREAM: stream };
  const previous = Object.fromEntries(Object.keys(applied).map((k) => [k, process.env[k]]));
  Object.assign(process.env, applied);
  process.env.LEDGER_SERVICE_URL = await ledger.start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        ...testDatabase,
        entities: [Transfer, SagaStep, OutboxMessage, SplitBill, SplitShare],
        synchronize: true,
        dropSchema: true,
      }),
      AuthModule,
      TransfersModule,
      SplitBillsModule,
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const dataSource = moduleRef.get(DataSource);
  const jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
  const http = () => request(app.getHttpServer());
  let counter = 0;

  const account = async (currency = 'USD', funds = '0'): Promise<Account> => {
    const email = `user-${++counter}-${randomUUID().slice(0, 8)}@example.com`;
    const userId = ledger.user(email);
    const wallet = ledger.openWallet(userId, currency, funds);
    const token = await jwt.signAsync({ sub: userId, email, role: 'user' }, { expiresIn: '15m' });
    return { token, userId, email, walletId: wallet.walletId };
  };

  const transfer = (from: Account, body: object, key: string = randomUUID()) =>
    http()
      .post('/transfers')
      .set('Authorization', `Bearer ${from.token}`)
      .set('Idempotency-Key', key)
      .send({ fromWalletId: from.walletId, ...body });

  const waitFor = async (
    token: string,
    id: string,
    done: (t: Record<string, unknown>) => boolean,
    timeoutMs = 10_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await http().get(`/transfers/${id}`).set('Authorization', `Bearer ${token}`).expect(200);
      if (done(res.body)) return res.body as Record<string, unknown>;
      if (Date.now() > deadline) {
        throw new Error(`Transfer ${id} did not reach the expected state: ${JSON.stringify(res.body)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  const settle = (token: string, id: string, timeoutMs = 10_000) =>
    waitFor(token, id, (t) => t.status === 'completed' || t.status === 'failed', timeoutMs);

  const redis = new Redis(process.env.REDIS_URL as string);
  const published = async (): Promise<PublishedEvent[]> => {
    const entries = await redis.xrange(stream, '-', '+');
    return entries.map(([, fields]) => {
      const map = new Map<string, string>();
      for (let i = 0; i < fields.length; i += 2) map.set(fields[i], fields[i + 1]);
      return {
        eventId: map.get('eventId') as string,
        type: map.get('type') as string,
        envelope: JSON.parse(map.get('envelope') as string) as EventEnvelope,
      };
    });
  };

  const close = async () => {
    await app.close();
    await ledger.stop();
    await redis.del(stream);
    redis.disconnect();
  };

  return {
    app,
    ledger,
    dataSource,
    worker: moduleRef.get(SagaWorker),
    http,
    account,
    transfer,
    settle,
    waitFor: (token, id, done) => waitFor(token, id, done),
    published,
    close,
  };
}
