import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthModule } from '../../src/auth/auth.module';
import { WalletsModule } from '../../src/wallets/wallets.module';
import { InternalModule } from '../../src/internal/internal.module';
import { INTERNAL_API_KEY_HEADER } from '../../src/internal/internal-api-key.guard';
import { User } from '../../src/auth/entities/user.entity';
import { Wallet } from '../../src/wallets/entities/wallet.entity';
import { Hold } from '../../src/wallets/entities/hold.entity';
import { LedgerEvent } from '../../src/ledger/entities/ledger-event.entity';
import { LedgerEntry } from '../../src/ledger/entities/ledger-entry.entity';

process.env.JWT_ACCESS_SECRET ??= 'int-access';
process.env.JWT_REFRESH_SECRET ??= 'int-refresh';
process.env.INTERNAL_API_KEY ??= 'int-internal-key';

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

export interface IntegrationApp {
  app: INestApplication;
  dataSource: DataSource;
  http: () => ReturnType<typeof request>;
  internal: (
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) => request.Test;
  registerUser: () => Promise<{ token: string; userId: string }>;
  openWallet: (token: string, currency?: string) => Promise<string>;
}

export async function createIntegrationApp(): Promise<IntegrationApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        ...testDatabase,
        entities: [User, Wallet, Hold, LedgerEvent, LedgerEntry],
        synchronize: true,
        dropSchema: true,
      }),
      AuthModule,
      WalletsModule,
      InternalModule,
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

  const openWallet = async (token: string, currency = 'USD') => {
    const res = await http()
      .post('/wallets')
      .set('Authorization', `Bearer ${token}`)
      .send({ currency })
      .expect(201);
    return res.body.id as string;
  };

  return { app, dataSource, http, internal, registerUser, openWallet };
}
