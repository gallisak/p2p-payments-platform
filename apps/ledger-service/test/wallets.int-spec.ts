import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { WalletsModule } from '../src/wallets/wallets.module';
import { User } from '../src/auth/entities/user.entity';
import { Wallet } from '../src/wallets/entities/wallet.entity';

process.env.JWT_ACCESS_SECRET ??= 'int-access';
process.env.JWT_REFRESH_SECRET ??= 'int-refresh';

describe('Wallets on Postgres (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let token: string;
  let ownerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DATABASE_HOST ?? 'localhost',
          port: Number(process.env.DATABASE_PORT ?? 5433),
          username: process.env.DATABASE_USER ?? 'ledger',
          password: process.env.DATABASE_PASSWORD ?? 'ledger',
          database: process.env.DATABASE_NAME ?? 'ledger',
          entities: [User, Wallet],
          synchronize: true,
        }),
        AuthModule,
        WalletsModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);

    const email = `int-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' })
      .expect(201);
    token = res.body.accessToken;
    ownerId = (await dataSource.getRepository(User).findOneByOrFail({ email }))
      .id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function walletWithBalance(balance: string): Promise<string> {
    const wallet = await dataSource
      .getRepository(Wallet)
      .save({ ownerId, currency: 'USD', balance });
    return wallet.id;
  }

  async function balanceOf(walletId: string): Promise<string> {
    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: walletId });
    return wallet.balance;
  }

  const send = (walletId: string, action: 'deposit' | 'withdraw', amount: number) =>
    request(app.getHttpServer())
      .post(`/wallets/${walletId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount });

  it('never lets concurrent withdrawals spend more than the balance', async () => {
    const walletId = await walletWithBalance('100.00');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => send(walletId, 'withdraw', 10)),
    );
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(10);
    expect(statuses.filter((s) => s === 400)).toHaveLength(10);
    expect(await balanceOf(walletId)).toBe('0.00');
  });

  it('does not lose concurrent deposits', async () => {
    const walletId = await walletWithBalance('0.00');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => send(walletId, 'deposit', 0.1)),
    );

    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await balanceOf(walletId)).toBe('2.00');
  });

  it('rejects a withdrawal above the balance without changing it', async () => {
    const walletId = await walletWithBalance('50.00');

    await send(walletId, 'withdraw', 50.01).expect(400);
    expect(await balanceOf(walletId)).toBe('50.00');
  });
});
