import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { WalletsModule } from '../src/wallets/wallets.module';
import { User } from '../src/auth/entities/user.entity';
import { Wallet } from '../src/wallets/entities/wallet.entity';

process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Мінімальний in-memory замінник TypeORM-репозиторію. Для невалідного UUID
// кидає помилку так само, як Postgres ("invalid input syntax for type uuid"),
// щоб тест бачив ту саму поведінку, що й бойова БД.
function inMemoryRepo<T extends { id?: string }>(rows: T[]) {
  const matches = (row: T, where: Partial<T>) =>
    Object.entries(where).every(
      ([key, value]) => row[key as keyof T] === value,
    );
  return {
    rows,
    findOne: jest.fn(async ({ where }: { where: Partial<T> }) => {
      if (where.id !== undefined && !UUID_RE.test(String(where.id))) {
        throw new Error('invalid input syntax for type uuid');
      }
      return rows.find((row) => matches(row, where)) ?? null;
    }),
    find: jest.fn(async ({ where }: { where: Partial<T> }) =>
      rows.filter((row) => matches(row, where)),
    ),
    create: jest.fn((entity: T) => entity),
    save: jest.fn(async (entity: T) => {
      const index = rows.findIndex((row) => row.id === entity.id);
      if (index >= 0) rows[index] = entity;
      else rows.push(entity);
      return entity;
    }),
  };
}

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b2b2b2b2-0000-4000-8000-000000000002';
const ALICE_WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOB_WALLET = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('Wallets API (e2e)', () => {
  let app: INestApplication;
  let wallets: ReturnType<typeof inMemoryRepo<Wallet>>;
  let aliceToken: string;
  let bobToken: string;

  beforeEach(async () => {
    wallets = inMemoryRepo<Wallet>([
      { id: ALICE_WALLET, ownerId: ALICE, currency: 'USD', balance: '100.00' },
      { id: BOB_WALLET, ownerId: BOB, currency: 'USD', balance: '100.00' },
    ] as Wallet[]);
    const users = inMemoryRepo<User>([]);

    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, WalletsModule],
    })
      .overrideProvider(getRepositoryToken(Wallet))
      .useValue(wallets)
      .overrideProvider(getRepositoryToken(User))
      .useValue(users)
      .compile();

    app = moduleRef.createNestApplication();
    // Ті самі налаштування, що й у src/main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    const jwt = new JwtService({ secret: 'test-access' });
    aliceToken = jwt.sign({ sub: ALICE, email: 'alice@example.com', role: 'user' });
    bobToken = jwt.sign({ sub: BOB, email: 'bob@example.com', role: 'user' });
  });

  afterEach(async () => {
    await app.close();
  });

  const balanceOf = (walletId: string) =>
    wallets.rows.find((w) => w.id === walletId)?.balance;

  describe('ownership (IDOR)', () => {
    it('lets the owner read their own wallet', async () => {
      const res = await request(app.getHttpServer())
        .get(`/wallets/${ALICE_WALLET}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      expect(res.body.id).toBe(ALICE_WALLET);
    });

    it('lists only the wallets of the current user', async () => {
      const res = await request(app.getHttpServer())
        .get('/wallets')
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);
      expect(res.body.map((w: Wallet) => w.id)).toEqual([BOB_WALLET]);
    });

    it("does not let another user read someone else's wallet", async () => {
      await request(app.getHttpServer())
        .get(`/wallets/${ALICE_WALLET}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(404);
    });

    it("does not let another user withdraw from someone else's wallet", async () => {
      await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/withdraw`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ amount: 40 })
        .expect(404);
      expect(balanceOf(ALICE_WALLET)).toBe('100.00');
    });

    it("does not let another user deposit into someone else's wallet", async () => {
      await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/deposit`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ amount: 40 })
        .expect(404);
      expect(balanceOf(ALICE_WALLET)).toBe('100.00');
    });

    it('lets the owner deposit into their own wallet', async () => {
      const res = await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/deposit`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ amount: 40 })
        .expect(201);
      expect(res.body.balance).toBe('140.00');
    });
  });

  describe('input validation', () => {
    it('rejects a wallet id that is not a UUID with 400, not 500', async () => {
      await request(app.getHttpServer())
        .get('/wallets/not-a-uuid')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
    });

    it('rejects amounts with more than 2 decimal places', async () => {
      await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/deposit`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ amount: 0.004 })
        .expect(400);
      expect(balanceOf(ALICE_WALLET)).toBe('100.00');
    });

    it('rejects tiny amounts in exponent notation with 400, not 500', async () => {
      for (const amount of [1e-7, 5e-324]) {
        await request(app.getHttpServer())
          .post(`/wallets/${ALICE_WALLET}/deposit`)
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({ amount })
          .expect(400);
      }
      expect(balanceOf(ALICE_WALLET)).toBe('100.00');
    });

    it('accepts 2-decimal amounts that are inexact in floating point', async () => {
      const res = await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/deposit`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ amount: 0.29 })
        .expect(201);
      expect(res.body.balance).toBe('100.29');
    });

    it('rejects amounts above the per-operation limit', async () => {
      await request(app.getHttpServer())
        .post(`/wallets/${ALICE_WALLET}/deposit`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ amount: 1e15 })
        .expect(400);
      expect(balanceOf(ALICE_WALLET)).toBe('100.00');
    });

    it('rejects passwords longer than bcrypt can hash (72 bytes)', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'long@example.com', password: 'x'.repeat(73) })
        .expect(400);
      // 42 символи кирилицею = 84 байти в UTF-8: ліміт bcrypt — у байтах.
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'cyr@example.com', password: 'пароль'.repeat(7) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'long@example.com', password: 'x'.repeat(10_000) })
        .expect(400);
    });
  });

  describe('login rate limiting', () => {
    const attempt = (email: string) =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'wrong-password' });

    it('blocks further attempts for an email after 5 failed logins', async () => {
      for (let i = 0; i < 5; i++) {
        await attempt('victim@example.com').expect(401);
      }
      await attempt('victim@example.com').expect(429);
    });

    it('does not block other users behind the same proxy IP', async () => {
      for (let i = 0; i < 6; i++) {
        await attempt('victim@example.com');
      }
      await attempt('someone-else@example.com').expect(401);
    });
  });
});
