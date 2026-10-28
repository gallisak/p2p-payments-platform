import { Wallet } from '../src/wallets/entities/wallet.entity';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

describe('Wallets API on Postgres (integration)', () => {
  let ctx: IntegrationApp;
  let alice: { token: string; userId: string };
  let bob: { token: string; userId: string };

  beforeAll(async () => {
    ctx = await createIntegrationApp();
    alice = await ctx.registerUser();
    bob = await ctx.registerUser();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const send = (
    token: string,
    walletId: string,
    action: 'deposit' | 'withdraw',
    amount: unknown,
  ) =>
    ctx
      .http()
      .post(`/wallets/${walletId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount });

  const balanceOf = async (walletId: string) =>
    (await ctx.dataSource.getRepository(Wallet).findOneByOrFail({ id: walletId }))
      .balance;

  async function fundedWallet(
    user: { token: string },
    balance: number,
    currency = 'USD',
  ): Promise<string> {
    const walletId = await ctx.openWallet(user.token, currency);
    if (balance > 0) {
      await send(user.token, walletId, 'deposit', balance).expect(201);
    }
    return walletId;
  }

  describe('starter WalletsService behaviour', () => {
    it('increases balance on deposit', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 100);

      const res = await send(user.token, walletId, 'deposit', 50).expect(201);

      expect(res.body.balance).toBe('150.00');
    });

    it('does not allow withdrawing more than the current balance', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 100);

      await send(user.token, walletId, 'withdraw', 500).expect(400);

      expect(await balanceOf(walletId)).toBe('100.00');
    });

    it("reports someone else's wallet as not found on withdraw", async () => {
      const walletId = await fundedWallet(await ctx.registerUser(), 100);

      await send(bob.token, walletId, 'withdraw', 10).expect(404);

      expect(await balanceOf(walletId)).toBe('100.00');
    });
  });

  describe('opening wallets', () => {
    it('opens an empty wallet for a supported currency', async () => {
      const user = await ctx.registerUser();
      const res = await ctx
        .http()
        .post('/wallets')
        .set('Authorization', `Bearer ${user.token}`)
        .send({ currency: 'EUR' })
        .expect(201);

      expect(res.body).toMatchObject({
        ownerId: user.userId,
        currency: 'EUR',
        balance: '0.00',
      });
    });

    it('returns the existing wallet instead of opening a second one', async () => {
      const user = await ctx.registerUser();
      const first = await ctx.openWallet(user.token, 'UAH');
      const second = await ctx.openWallet(user.token, 'UAH');

      expect(second).toBe(first);
    });

    it('opens exactly one wallet under concurrent requests', async () => {
      const user = await ctx.registerUser();

      const ids = await Promise.all(
        Array.from({ length: 10 }, () => ctx.openWallet(user.token, 'USD')),
      );

      expect(new Set(ids).size).toBe(1);
      const opened = await ctx.dataSource
        .getRepository(LedgerEvent)
        .countBy({ streamId: ids[0], type: 'WalletOpened' });
      expect(opened).toBe(1);
      expect(
        await ctx.dataSource
          .getRepository(Wallet)
          .countBy({ ownerId: user.userId, currency: 'USD' }),
      ).toBe(1);
    });

    it('lists wallets in a stable order by currency', async () => {
      const user = await ctx.registerUser();
      for (const currency of ['UAH', 'USD', 'EUR']) {
        await ctx.openWallet(user.token, currency);
      }

      const res = await ctx
        .http()
        .get('/wallets')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(200);

      expect(res.body.map((w: Wallet) => w.currency)).toEqual(['EUR', 'UAH', 'USD']);
    });

    it('keeps separate wallets per currency', async () => {
      const user = await ctx.registerUser();
      const usd = await ctx.openWallet(user.token, 'USD');
      const eur = await ctx.openWallet(user.token, 'EUR');

      expect(usd).not.toBe(eur);
    });

    it('rejects unsupported currencies', async () => {
      await ctx
        .http()
        .post('/wallets')
        .set('Authorization', `Bearer ${alice.token}`)
        .send({ currency: 'BTC' })
        .expect(400);
    });
  });

  describe('ownership (IDOR)', () => {
    let aliceWallet: string;
    let bobWallet: string;

    beforeAll(async () => {
      aliceWallet = await fundedWallet(alice, 100);
      bobWallet = await fundedWallet(bob, 100);
    });

    it('lets the owner read their own wallet', async () => {
      const res = await ctx
        .http()
        .get(`/wallets/${aliceWallet}`)
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      expect(res.body.id).toBe(aliceWallet);
    });

    it('lists only the wallets of the current user', async () => {
      const res = await ctx
        .http()
        .get('/wallets')
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(200);
      expect(res.body.map((w: Wallet) => w.id)).toEqual([bobWallet]);
    });

    it("does not let another user read someone else's wallet", async () => {
      await ctx
        .http()
        .get(`/wallets/${aliceWallet}`)
        .set('Authorization', `Bearer ${bob.token}`)
        .expect(404);
    });

    it("does not let another user withdraw from someone else's wallet", async () => {
      await send(bob.token, aliceWallet, 'withdraw', 40).expect(404);
      expect(await balanceOf(aliceWallet)).toBe('100.00');
    });

    it("does not let another user deposit into someone else's wallet", async () => {
      await send(bob.token, aliceWallet, 'deposit', 40).expect(404);
      expect(await balanceOf(aliceWallet)).toBe('100.00');
    });

    it('lets the owner deposit into their own wallet', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 100);
      const res = await send(user.token, walletId, 'deposit', 40).expect(201);
      expect(res.body.balance).toBe('140.00');
    });

    it('requires authentication', async () => {
      await ctx.http().get(`/wallets/${aliceWallet}`).expect(401);
    });
  });

  describe('input validation', () => {
    let walletId: string;
    let user: { token: string; userId: string };

    beforeAll(async () => {
      user = await ctx.registerUser();
      walletId = await fundedWallet(user, 100);
    });

    it('rejects a wallet id that is not a UUID with 400, not 500', async () => {
      await ctx
        .http()
        .get('/wallets/not-a-uuid')
        .set('Authorization', `Bearer ${user.token}`)
        .expect(400);
    });

    it('rejects amounts with more than 2 decimal places', async () => {
      await send(user.token, walletId, 'deposit', 0.004).expect(400);
      expect(await balanceOf(walletId)).toBe('100.00');
    });

    it('rejects tiny amounts in exponent notation with 400, not 500', async () => {
      for (const amount of [1e-7, 5e-324]) {
        await send(user.token, walletId, 'deposit', amount).expect(400);
      }
      expect(await balanceOf(walletId)).toBe('100.00');
    });

    it('rejects amounts above the per-operation limit', async () => {
      await send(user.token, walletId, 'deposit', 1e15).expect(400);
      expect(await balanceOf(walletId)).toBe('100.00');
    });

    it('rejects zero, negative and non-numeric amounts', async () => {
      for (const amount of [0, -5, '10', null]) {
        await send(user.token, walletId, 'deposit', amount).expect(400);
      }
      expect(await balanceOf(walletId)).toBe('100.00');
    });

    it('accepts 2-decimal amounts that are inexact in floating point', async () => {
      const res = await send(user.token, walletId, 'deposit', 0.29).expect(201);
      expect(res.body.balance).toBe('100.29');
    });
  });

  describe('concurrency', () => {
    it('never lets concurrent withdrawals spend more than the balance', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 100);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          send(user.token, walletId, 'withdraw', 10),
        ),
      );
      const statuses = responses.map((r) => r.status);

      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.filter((s) => s === 400)).toHaveLength(10);
      expect(await balanceOf(walletId)).toBe('0.00');
    });

    it('does not lose concurrent deposits', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 0);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          send(user.token, walletId, 'deposit', 0.1),
        ),
      );

      expect(responses.every((r) => r.status === 201)).toBe(true);
      expect(await balanceOf(walletId)).toBe('2.00');
    });

    it('rejects a withdrawal above the balance without changing it', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 50);

      await send(user.token, walletId, 'withdraw', 50.01).expect(400);
      expect(await balanceOf(walletId)).toBe('50.00');
    });

    it('compares balance and amount as numbers, not as text', async () => {
      const user = await ctx.registerUser();
      const walletId = await fundedWallet(user, 9);

      await send(user.token, walletId, 'withdraw', 10).expect(400);
      expect(await balanceOf(walletId)).toBe('9.00');

      await send(user.token, walletId, 'withdraw', 9).expect(201);
      expect(await balanceOf(walletId)).toBe('0.00');
    });
  });
});
