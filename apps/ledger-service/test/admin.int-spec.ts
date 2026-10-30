import { randomUUID } from 'crypto';
import { User } from '../src/auth/entities/user.entity';
import { AdminSeeder } from '../src/auth/admin.seeder';
import { Wallet } from '../src/wallets/entities/wallet.entity';
import { Hold } from '../src/wallets/entities/hold.entity';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

interface Account {
  token: string;
  userId: string;
  walletId: string;
  currency: string;
}

describe('Admin API on Postgres (integration)', () => {
  let ctx: IntegrationApp;
  let admin: string;
  let adminId: string;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    admin = await ctx.adminToken();
    adminId = (
      await ctx.dataSource
        .getRepository(User)
        .findOneByOrFail({ email: process.env.ADMIN_EMAIL })
    ).id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function account(currency = 'USD', funds = 0): Promise<Account> {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token, currency);
    if (funds > 0) {
      await ctx
        .http()
        .post(`/wallets/${walletId}/deposit`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ amount: funds })
        .expect(201);
    }
    return { ...user, walletId, currency };
  }

  const asAdmin = (method: 'get' | 'post', path: string, body?: object) => {
    const req = ctx.http()[method](`/admin${path}`).set('Authorization', `Bearer ${admin}`);
    return body ? req.send(body) : req;
  };

  const place = (from: Account, amount: number) =>
    ctx.internal('post', '/holds', {
      holdId: randomUUID(),
      walletId: from.walletId,
      ownerId: from.userId,
      amount,
    });

  const capture = (holdId: string, to: Account, amount: number) =>
    ctx.internal('post', `/holds/${holdId}/capture`, {
      toWalletId: to.walletId,
      amount,
      currency: to.currency,
    });

  const userCall = (user: Account, action: 'deposit' | 'withdraw', amount: number) =>
    ctx
      .http()
      .post(`/wallets/${user.walletId}/${action}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount });

  const wallet = (id: string) =>
    ctx.dataSource.getRepository(Wallet).findOneByOrFail({ id });

  describe('access', () => {
    it('lets the seeded admin into the admin API', async () => {
      await asAdmin('get', '/reconciliation').expect(200);
      await asAdmin('get', '/me').expect(200, { role: 'admin' });
    });

    it('forbids regular users', async () => {
      const user = await account('USD', 10);
      const endpoints: ['get' | 'post', string][] = [
        ['get', `/admin/wallets/${user.walletId}/events`],
        ['get', '/admin/me'],
        ['get', '/admin/reconciliation'],
        ['post', '/admin/projections/rebuild'],
        ['post', `/admin/wallets/${user.walletId}/block`],
        ['post', `/admin/wallets/${user.walletId}/unblock`],
      ];
      for (const [method, path] of endpoints) {
        await ctx
          .http()[method](path)
          .set('Authorization', `Bearer ${user.token}`)
          .send({ reason: 'x' })
          .expect(403);
      }
      expect((await wallet(user.walletId)).blocked).toBe(false);
    });

    it('requires authentication', async () => {
      await ctx.http().get('/admin/reconciliation').expect(401);
    });

    it('seeds the admin only once', async () => {
      await new AdminSeeder(ctx.dataSource.getRepository(User)).onApplicationBootstrap();

      expect(
        await ctx.dataSource
          .getRepository(User)
          .countBy({ email: process.env.ADMIN_EMAIL, role: 'admin' }),
      ).toBe(1);
    });

    it('treats ADMIN_EMAIL written in another letter case as the same admin', async () => {
      const original = process.env.ADMIN_EMAIL as string;
      process.env.ADMIN_EMAIL = `  ${original.toUpperCase()} `;
      try {
        await new AdminSeeder(ctx.dataSource.getRepository(User)).onApplicationBootstrap();
      } finally {
        process.env.ADMIN_EMAIL = original;
      }

      expect(await ctx.dataSource.getRepository(User).countBy({ role: 'admin' })).toBe(1);
    });

    it('refuses to turn an existing regular user into the admin', async () => {
      const user = await ctx.registerUser();
      const { email } = await ctx.dataSource
        .getRepository(User)
        .findOneByOrFail({ id: user.userId });
      const original = process.env.ADMIN_EMAIL;
      process.env.ADMIN_EMAIL = email;
      try {
        await expect(
          new AdminSeeder(ctx.dataSource.getRepository(User)).onApplicationBootstrap(),
        ).rejects.toThrow('refusing to grant it admin rights');
      } finally {
        process.env.ADMIN_EMAIL = original;
      }
      expect(
        (await ctx.dataSource.getRepository(User).findOneByOrFail({ id: user.userId })).role,
      ).toBe('user');
    });

    it.each([
      ['an invalid email', { ADMIN_EMAIL: 'admin@' }, 'is not a valid email address'],
      ['a short password', { ADMIN_PASSWORD: 'short' }, 'between 8 and 72 bytes'],
      ['a password longer than 72 bytes', { ADMIN_PASSWORD: 'x'.repeat(73) }, 'between 8 and 72 bytes'],
    ])('refuses to start with %s', async (_, override, message) => {
      const original = { ...process.env };
      Object.assign(process.env, override);
      try {
        await expect(
          new AdminSeeder(ctx.dataSource.getRepository(User)).onApplicationBootstrap(),
        ).rejects.toThrow(message);
      } finally {
        process.env.ADMIN_EMAIL = original.ADMIN_EMAIL;
        process.env.ADMIN_PASSWORD = original.ADMIN_PASSWORD;
      }
    });

    it('requires both admin variables together', async () => {
      const original = process.env.ADMIN_PASSWORD;
      delete process.env.ADMIN_PASSWORD;
      try {
        await expect(
          new AdminSeeder(ctx.dataSource.getRepository(User)).onApplicationBootstrap(),
        ).rejects.toThrow('must be set together');
      } finally {
        process.env.ADMIN_PASSWORD = original;
      }
    });
  });

  describe('wallet event log', () => {
    it('returns the events of a wallet in chronological order', async () => {
      const user = await account('USD', 100);
      await place(user, 30).expect(201);
      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'kyc' }).expect(201);

      const res = await asAdmin('get', `/wallets/${user.walletId}/events`).expect(200);

      expect(res.body.map((e: { type: string }) => e.type)).toEqual([
        'WalletOpened',
        'MoneyDeposited',
        'HoldPlaced',
        'WalletBlocked',
      ]);
      expect(res.body.map((e: { streamVersion: number }) => e.streamVersion)).toEqual([1, 2, 3, 4]);
      const times = res.body.map((e: { occurredAt: string }) => Date.parse(e.occurredAt));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(res.body[3]).toMatchObject({ payload: { reason: 'kyc' }, metadata: { actorId: adminId } });
    });

    it('reports an unknown wallet as not found', async () => {
      await asAdmin('get', `/wallets/${randomUUID()}/events`).expect(404);
      await asAdmin('get', '/wallets/not-a-uuid/events').expect(400);
    });
  });

  describe('blocking wallets', () => {
    it('records who blocked the wallet and why, once', async () => {
      const user = await account('USD', 10);

      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'fraud check' }).expect(201);
      const again = await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'again' }).expect(201);

      expect(again.body.blocked).toBe(true);
      const blocks = await ctx.dataSource
        .getRepository(LedgerEvent)
        .findBy({ streamId: user.walletId, type: 'WalletBlocked' });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].payload).toEqual({ reason: 'fraud check' });
      expect(blocks[0].metadata).toEqual({ actorId: adminId });
    });

    it('validates the block request', async () => {
      const user = await account('USD', 10);
      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: '' }).expect(400);
      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'x'.repeat(201) }).expect(400);
      await asAdmin('post', `/wallets/${randomUUID()}/block`, { reason: 'x' }).expect(404);
    });

    it('freezes deposits, withdrawals and new holds on a blocked wallet', async () => {
      const user = await account('USD', 100);
      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'kyc' }).expect(201);

      await userCall(user, 'deposit', 10).expect(423);
      await userCall(user, 'withdraw', 10).expect(423);
      await place(user, 10).expect(423);

      expect(await wallet(user.walletId)).toMatchObject({ balance: '100.00', held: '0.00' });
    });

    it('fails a transfer to a recipient blocked after the funds were reserved, and lets the hold be released', async () => {
      const sender = await account('USD', 100);
      const recipient = await account('USD');
      const hold = await place(sender, 40).expect(201);
      await asAdmin('post', `/wallets/${recipient.walletId}/block`, { reason: 'sanctions' }).expect(201);

      await capture(hold.body.id, recipient, 40).expect(423);

      expect(
        (await ctx.dataSource.getRepository(Hold).findOneByOrFail({ id: hold.body.id })).status,
      ).toBe('placed');
      await ctx.internal('post', `/holds/${hold.body.id}/release`).expect(201);
      expect(await wallet(sender.walletId)).toMatchObject({ balance: '100.00', held: '0.00' });
      expect(await wallet(recipient.walletId)).toMatchObject({ balance: '0.00' });
    });

    it('fails a transfer from a sender blocked after the funds were reserved', async () => {
      const sender = await account('USD', 100);
      const recipient = await account('USD');
      const hold = await place(sender, 40).expect(201);
      await asAdmin('post', `/wallets/${sender.walletId}/block`, { reason: 'kyc' }).expect(201);

      await capture(hold.body.id, recipient, 40).expect(423);
      await ctx.internal('post', `/holds/${hold.body.id}/release`).expect(201);

      expect(await wallet(sender.walletId)).toMatchObject({ balance: '100.00', held: '0.00' });
    });

    it('still confirms a transfer that was captured before the block', async () => {
      const sender = await account('USD', 100);
      const recipient = await account('USD');
      const hold = await place(sender, 40).expect(201);
      await capture(hold.body.id, recipient, 40).expect(201);
      await asAdmin('post', `/wallets/${recipient.walletId}/block`, { reason: 'later' }).expect(201);

      await capture(hold.body.id, recipient, 40).expect(201);
      expect((await wallet(recipient.walletId)).balance).toBe('40.00');
    });

    it('reports the blocked state in the recipient lookup', async () => {
      const user = await account('EUR', 0);
      const { email } = await ctx.dataSource
        .getRepository(User)
        .findOneByOrFail({ id: user.userId });
      await asAdmin('post', `/wallets/${user.walletId}/block`, { reason: 'kyc' }).expect(201);

      const res = await ctx.internal('post', '/recipients', { email, currency: 'EUR' }).expect(201);

      expect(res.body).toMatchObject({ walletId: user.walletId, blocked: true });
    });

    it('lets transfers through again after unblocking', async () => {
      const sender = await account('USD', 100);
      const recipient = await account('USD');
      await asAdmin('post', `/wallets/${recipient.walletId}/block`, { reason: 'kyc' }).expect(201);
      const hold = await place(sender, 40).expect(201);
      await capture(hold.body.id, recipient, 40).expect(423);

      const unblocked = await asAdmin('post', `/wallets/${recipient.walletId}/unblock`).expect(201);
      await asAdmin('post', `/wallets/${recipient.walletId}/unblock`).expect(201);
      await capture(hold.body.id, recipient, 40).expect(201);

      expect(unblocked.body.blocked).toBe(false);
      expect((await wallet(recipient.walletId)).balance).toBe('40.00');
      const unblocks = await ctx.dataSource
        .getRepository(LedgerEvent)
        .countBy({ streamId: recipient.walletId, type: 'WalletUnblocked' });
      expect(unblocks).toBe(1);
    });
  });

  describe('reconciliation', () => {
    it('reports a clean ledger after real activity', async () => {
      const sender = await account('USD', 100);
      const recipient = await account('EUR');
      const hold = await place(sender, 50).expect(201);
      await capture(hold.body.id, recipient, 46.17).expect(201);

      const res = await asAdmin('get', '/reconciliation').expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.unbalancedOperations).toEqual([]);
      expect(res.body.projections.mismatches).toEqual([]);
      expect(res.body.projections.checked).toBe(
        await ctx.dataSource.getRepository(Wallet).count(),
      );
      const currencies = res.body.totals.map((t: { currency: string }) => t.currency);
      expect(currencies).toEqual(expect.arrayContaining(['EUR', 'USD']));
      for (const total of res.body.totals) {
        expect(total.net).toBe('0.00');
        expect(total.debits).toBe(total.credits);
        expect(total.operations).toBeGreaterThan(0);
      }
    });

    it('stays consistent while money keeps moving', async () => {
      const users = await Promise.all(
        Array.from({ length: 8 }, () => account('USD', 100)),
      );
      const traffic = Promise.all(
        Array.from({ length: 160 }, (_, i) =>
          userCall(users[i % users.length], i % 3 ? 'deposit' : 'withdraw', 1),
        ),
      );
      const reports = await Promise.all(
        Array.from({ length: 6 }, () => asAdmin('get', '/reconciliation')),
      );
      await traffic;

      for (const report of reports) {
        expect(report.status).toBe(200);
        expect(report.body.projections.mismatches).toEqual([]);
        expect(report.body.ok).toBe(true);
      }
    });

    it('limits ledger totals to the requested period', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const res = await asAdmin('get', `/reconciliation?from=${encodeURIComponent(future)}`).expect(200);

      expect(res.body.totals).toEqual([]);
      expect(res.body.period.from).toBe(future);
    });

    it('validates the period', async () => {
      await asAdmin('get', '/reconciliation?from=yesterday').expect(400);
      await asAdmin(
        'get',
        '/reconciliation?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      ).expect(400);
    });

    it.each([
      ['balance', 'balance = balance + 5', 'balance differs from the event log'],
      ['held', 'held = held + 5', 'held differs from the event log'],
      ['blocked flag', 'blocked = true', 'blocked flag differs from the event log'],
      ['version', 'version = version + 1', 'version differs from the event log'],
    ])('detects a tampered %s and rebuilds it from the event log', async (_, change, issue) => {
      const user = await account('USD', 100);
      await ctx.dataSource.query(`UPDATE wallets SET ${change} WHERE id = $1`, [user.walletId]);

      const broken = await asAdmin('get', '/reconciliation').expect(200);
      expect(broken.body.ok).toBe(false);
      expect(broken.body.projections.mismatches).toEqual([
        expect.objectContaining({
          walletId: user.walletId,
          issues: expect.arrayContaining([issue]),
          rebuilt: { balance: '100.00', held: '0.00', blocked: false, version: 2 },
        }),
      ]);

      const rebuilt = await asAdmin('post', '/projections/rebuild').expect(201);
      expect(rebuilt.body).toEqual({ rebuilt: [user.walletId], skipped: [] });
      expect(await wallet(user.walletId)).toMatchObject({
        balance: '100.00',
        held: '0.00',
        blocked: false,
        version: 2,
      });
      expect((await asAdmin('get', '/reconciliation').expect(200)).body.ok).toBe(true);
    });

    it('detects a projection that has no events behind it', async () => {
      const user = await ctx.registerUser();
      const id = randomUUID();
      await ctx.dataSource.query(
        `INSERT INTO wallets (id, "ownerId", currency, balance, held, blocked, version)
         VALUES ($1, $2, 'UAH', 50, 0, false, 1)`,
        [id, user.userId],
      );

      const res = await asAdmin('get', '/reconciliation').expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.projections.mismatches).toEqual([
        expect.objectContaining({ walletId: id, issues: ['wallet projection has no events'] }),
      ]);
      const rebuilt = await asAdmin('post', '/projections/rebuild').expect(201);
      expect(rebuilt.body.skipped).toEqual([
        { walletId: id, issues: ['stream has no events'] },
      ]);
      await ctx.dataSource.query('DELETE FROM wallets WHERE id = $1', [id]);
    });

    it('detects postings that do not balance (corrupts the ledger, keep last but one)', async () => {
      const operationId = randomUUID();
      await ctx.dataSource.query(
        `INSERT INTO ledger_entries ("operationId", "eventId", "accountId", currency, amount)
         VALUES ($1, $2, 'external:USD', 'USD', 7.5)`,
        [operationId, randomUUID()],
      );

      const res = await asAdmin('get', '/reconciliation').expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.unbalancedOperations).toEqual([
        { operationId, currency: 'USD', total: '7.50' },
      ]);
      expect(res.body.totals.find((t: { currency: string }) => t.currency === 'USD').net).toBe('7.50');
    });

    it('detects a gap in a wallet event stream and refuses to rebuild it (corrupts the ledger, keep last)', async () => {
      const user = await account('USD', 10);
      await ctx.dataSource.query(
        `INSERT INTO ledger_events ("eventId", "streamId", "streamVersion", type, "schemaVersion", payload)
         VALUES ($1, $2, 4, 'MoneyDeposited', 2,
                 '{"operationId": "x", "amount": "1.00", "currency": "USD", "postings": []}')`,
        [randomUUID(), user.walletId],
      );

      const res = await asAdmin('get', '/reconciliation').expect(200);
      const mismatch = res.body.projections.mismatches.find(
        (m: { walletId: string }) => m.walletId === user.walletId,
      );
      expect(mismatch.issues).toEqual(
        expect.arrayContaining(['version gap: expected 3, found 4']),
      );

      const rebuilt = await asAdmin('post', '/projections/rebuild').expect(201);
      expect(rebuilt.body.skipped).toEqual([
        { walletId: user.walletId, issues: ['version gap: expected 3, found 4'] },
      ]);
      expect((await wallet(user.walletId)).balance).toBe('10.00');
    });
  });
});
