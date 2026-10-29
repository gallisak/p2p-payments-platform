import { randomUUID } from 'crypto';
import { Wallet } from '../src/wallets/entities/wallet.entity';
import { Hold } from '../src/wallets/entities/hold.entity';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { LedgerEntry } from '../src/ledger/entities/ledger-entry.entity';
import { StoredEvent } from '../src/ledger/ledger-events';
import { formatCents, toCents } from '../src/ledger/money';
import { foldWallet } from '../src/ledger/wallet-projection';
import { INTERNAL_API_KEY_HEADER } from '../src/internal/internal-api-key.guard';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

interface Account {
  token: string;
  userId: string;
  walletId: string;
  currency: string;
}

describe('Holds and transfer settlement on Postgres (integration)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
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

  const wallet = (id: string) =>
    ctx.dataSource.getRepository(Wallet).findOneByOrFail({ id });

  const place = (from: Account, amount: number, holdId = randomUUID()) =>
    ctx.internal('post', '/holds', {
      holdId,
      walletId: from.walletId,
      ownerId: from.userId,
      amount,
    });

  const capture = (
    holdId: string,
    to: Account,
    amount: number,
    currency = to.currency,
  ) =>
    ctx.internal('post', `/holds/${holdId}/capture`, {
      toWalletId: to.walletId,
      amount,
      currency,
    });

  const release = (holdId: string, walletId?: string) =>
    ctx.internal('post', `/holds/${holdId}/release`, walletId ? { walletId } : undefined);

  const eventsOf = async (streamId: string) =>
    ctx.dataSource
      .getRepository(LedgerEvent)
      .find({ where: { streamId }, order: { streamVersion: 'ASC' } });

  describe('internal API access', () => {
    it('rejects requests without the internal API key', async () => {
      const from = await account('USD', 10);
      await ctx
        .http()
        .post('/internal/holds')
        .send({ holdId: randomUUID(), walletId: from.walletId, ownerId: from.userId, amount: 1 })
        .expect(401);
    });

    it('rejects a wrong internal API key', async () => {
      await ctx
        .http()
        .post('/internal/recipients')
        .set(INTERNAL_API_KEY_HEADER, 'wrong-key')
        .send({ email: 'a@example.com', currency: 'USD' })
        .expect(401);
    });

    it('does not accept a user access token instead of the internal key', async () => {
      const from = await account('USD', 10);
      await ctx
        .http()
        .post(`/internal/holds/${randomUUID()}/release`)
        .set('Authorization', `Bearer ${from.token}`)
        .expect(401);
    });
  });

  describe('recipient lookup', () => {
    it('finds a recipient by email and opens a wallet in the requested currency', async () => {
      const user = await ctx.registerUser();
      const email = (
        await ctx.dataSource.query('SELECT email FROM users WHERE id = $1', [user.userId])
      )[0].email as string;

      const first = await ctx
        .internal('post', '/recipients', { email, currency: 'EUR' })
        .expect(201);
      const second = await ctx
        .internal('post', '/recipients', { email, currency: 'EUR' })
        .expect(201);

      expect(first.body).toMatchObject({ ownerId: user.userId, currency: 'EUR' });
      expect(second.body.walletId).toBe(first.body.walletId);
    });

    it('reports an unknown recipient as not found', async () => {
      await ctx
        .internal('post', '/recipients', { email: 'nobody@example.com', currency: 'USD' })
        .expect(404);
    });

    it('validates the lookup query', async () => {
      await ctx
        .internal('post', '/recipients', { email: 'not-an-email', currency: 'USD' })
        .expect(400);
      await ctx
        .internal('post', '/recipients', { email: 'a@example.com', currency: 'BTC' })
        .expect(400);
    });
  });

  describe('wallet lookup', () => {
    it('describes a wallet of its owner', async () => {
      const user = await account('EUR', 5);

      const res = await ctx
        .internal('get', `/wallets/${user.walletId}?ownerId=${user.userId}`)
        .expect(200);

      expect(res.body).toEqual({
        walletId: user.walletId,
        ownerId: user.userId,
        currency: 'EUR',
        blocked: false,
      });
    });

    it('reports a wallet of another user as not found', async () => {
      const owner = await account('USD');
      const other = await account('USD');
      await ctx
        .internal('get', `/wallets/${owner.walletId}?ownerId=${other.userId}`)
        .expect(404);
    });

    it('shows that a wallet is blocked', async () => {
      const user = await account('USD');
      const admin = await ctx.adminToken();
      await ctx
        .http()
        .post(`/admin/wallets/${user.walletId}/block`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ reason: 'fraud check' })
        .expect(201);

      const res = await ctx
        .internal('get', `/wallets/${user.walletId}?ownerId=${user.userId}`)
        .expect(200);
      expect(res.body.blocked).toBe(true);
    });

    it('validates the lookup', async () => {
      const user = await account('USD');
      await ctx.internal('get', `/wallets/${user.walletId}`).expect(400);
      await ctx.internal('get', `/wallets/not-a-uuid?ownerId=${user.userId}`).expect(400);
      await ctx
        .http()
        .get(`/internal/wallets/${user.walletId}?ownerId=${user.userId}`)
        .expect(401);
    });
  });

  describe('placing holds', () => {
    it('reserves funds without changing the balance', async () => {
      const from = await account('USD', 100);

      const res = await place(from, 40).expect(201);

      expect(res.body).toMatchObject({ status: 'placed', amount: '40.00', currency: 'USD' });
      expect(await wallet(from.walletId)).toMatchObject({ balance: '100.00', held: '40.00' });
    });

    it('makes held funds unavailable for withdrawals', async () => {
      const from = await account('USD', 100);
      await place(from, 40).expect(201);

      const withdraw = (amount: number) =>
        ctx
          .http()
          .post(`/wallets/${from.walletId}/withdraw`)
          .set('Authorization', `Bearer ${from.token}`)
          .send({ amount });

      await withdraw(60.01).expect(400);
      await withdraw(60).expect(201);
      expect(await wallet(from.walletId)).toMatchObject({ balance: '40.00', held: '40.00' });
    });

    it('refuses a hold above the available balance and records nothing', async () => {
      const from = await account('USD', 100);
      await place(from, 70).expect(201);

      await place(from, 30.01).expect(400);

      expect((await wallet(from.walletId)).held).toBe('70.00');
      expect(await eventsOf(from.walletId)).toHaveLength(3);
    });

    it("does not let one user's hold touch another user's wallet", async () => {
      const from = await account('USD', 100);
      const other = await account('USD', 0);

      await ctx
        .internal('post', '/holds', {
          holdId: randomUUID(),
          walletId: from.walletId,
          ownerId: other.userId,
          amount: 10,
        })
        .expect(404);
      expect((await wallet(from.walletId)).held).toBe('0.00');
    });

    it('treats a repeated hold with the same id as the same hold', async () => {
      const from = await account('USD', 100);
      const holdId = randomUUID();

      const first = await place(from, 25, holdId).expect(201);
      const second = await place(from, 25, holdId).expect(201);

      expect(second.body).toEqual(first.body);
      expect((await wallet(from.walletId)).held).toBe('25.00');
      const placed = (await eventsOf(from.walletId)).filter((e) => e.type === 'HoldPlaced');
      expect(placed).toHaveLength(1);
    });

    it('rejects a hold id reused with different parameters', async () => {
      const from = await account('USD', 100);
      const holdId = randomUUID();
      await place(from, 25, holdId).expect(201);

      await place(from, 26, holdId).expect(409);
    });

    it('validates the hold request', async () => {
      const from = await account('USD', 100);
      for (const amount of [0, -1, 0.001, 1e7]) {
        await place(from, amount).expect(400);
      }
      await ctx
        .internal('post', '/holds', { holdId: 'nope', walletId: from.walletId, ownerId: from.userId, amount: 1 })
        .expect(400);
    });

    it('never reserves more than the available balance under concurrent holds', async () => {
      const from = await account('USD', 100);

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => place(from, 10)),
      );
      const statuses = responses.map((r) => r.status);

      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.filter((s) => s === 400)).toHaveLength(10);
      expect(await wallet(from.walletId)).toMatchObject({ balance: '100.00', held: '100.00' });
    });

    it('never overspends under concurrent holds and withdrawals on one wallet', async () => {
      const from = await account('USD', 100);

      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          i % 2
            ? ctx
                .http()
                .post(`/wallets/${from.walletId}/withdraw`)
                .set('Authorization', `Bearer ${from.token}`)
                .send({ amount: 10 })
            : place(from, 10),
        ),
      );
      const statuses = responses.map((r) => r.status);

      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.filter((s) => s !== 201 && s !== 400)).toEqual([]);
      const after = await wallet(from.walletId);
      expect(toCents(after.balance)).toBe(toCents(after.held));
    });

    it('creates exactly one hold when the same hold is retried concurrently', async () => {
      const from = await account('USD', 100);
      const holdId = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => place(from, 30, holdId)),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect((await wallet(from.walletId)).held).toBe('30.00');
      const placed = (await eventsOf(from.walletId)).filter((e) => e.type === 'HoldPlaced');
      expect(placed).toHaveLength(1);
    });
  });

  describe('releasing holds', () => {
    it('returns the reserved funds', async () => {
      const from = await account('USD', 100);
      const hold = await place(from, 40).expect(201);

      const res = await release(hold.body.id).expect(201);

      expect(res.body.status).toBe('released');
      expect(await wallet(from.walletId)).toMatchObject({ balance: '100.00', held: '0.00' });
    });

    it('is idempotent', async () => {
      const from = await account('USD', 100);
      const hold = await place(from, 40).expect(201);

      await release(hold.body.id).expect(201);
      await release(hold.body.id).expect(201);

      expect((await wallet(from.walletId)).held).toBe('0.00');
      const released = (await eventsOf(from.walletId)).filter((e) => e.type === 'HoldReleased');
      expect(released).toHaveLength(1);
    });

    it('reports an unknown hold as not found', async () => {
      await release(randomUUID()).expect(404);
    });

    it('refuses to release a hold that was already captured', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);
      await capture(hold.body.id, to, 40).expect(201);

      await release(hold.body.id).expect(409);

      expect(await wallet(to.walletId)).toMatchObject({ balance: '40.00' });
    });

    it('voids a hold id that was never placed so that a late placement cannot reserve funds', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const holdId = randomUUID();
      const before = (await eventsOf(from.walletId)).length;

      const voided = await release(holdId, from.walletId).expect(201);
      await release(holdId, from.walletId).expect(201);

      expect(voided.body).toMatchObject({ id: holdId, status: 'voided', amount: '0.00' });
      await place(from, 40, holdId).expect(409);
      await capture(holdId, to, 40).expect(409);
      expect(await wallet(from.walletId)).toMatchObject({ balance: '100.00', held: '0.00' });
      expect(await eventsOf(from.walletId)).toHaveLength(before);
    });

    it('releases a placed hold when the release names its wallet', async () => {
      const from = await account('USD', 100);
      const hold = await place(from, 40).expect(201);

      const res = await release(hold.body.id, from.walletId).expect(201);

      expect(res.body.status).toBe('released');
      expect((await wallet(from.walletId)).held).toBe('0.00');
    });

    it('refuses a release that names another wallet of the hold', async () => {
      const from = await account('USD', 100);
      const other = await account('USD');
      const hold = await place(from, 40).expect(201);

      await release(hold.body.id, other.walletId).expect(400);
      await release(randomUUID(), randomUUID()).expect(404);
      await ctx.internal('post', `/holds/${randomUUID()}/release`, { walletId: 'nope' }).expect(400);

      expect((await wallet(from.walletId)).held).toBe('40.00');
    });

    it('lets exactly one of a concurrent placement and void of the same hold id win', async () => {
      for (let i = 0; i < 5; i++) {
        const from = await account('USD', 100);
        const holdId = randomUUID();

        const [placed, voided] = await Promise.all([
          place(from, 40, holdId),
          release(holdId, from.walletId),
        ]);

        expect(voided.status).toBe(201);
        const held = (await wallet(from.walletId)).held;
        if (placed.status === 201) {
          expect(voided.body.status).toBe('released');
        } else {
          expect(placed.status).toBe(409);
          expect(voided.body.status).toBe('voided');
        }
        expect(held).toBe('0.00');
      }
    });
  });

  describe('capturing holds', () => {
    it('moves held funds to the recipient in the same currency', async () => {
      const from = await account('USD', 100);
      const to = await account('USD', 5);
      const hold = await place(from, 40).expect(201);

      const res = await capture(hold.body.id, to, 40).expect(201);

      expect(res.body).toMatchObject({
        status: 'captured',
        toWalletId: to.walletId,
        creditAmount: '40.00',
        creditCurrency: 'USD',
      });
      expect(await wallet(from.walletId)).toMatchObject({ balance: '60.00', held: '0.00' });
      expect(await wallet(to.walletId)).toMatchObject({ balance: '45.00', held: '0.00' });

      const sent = (await eventsOf(from.walletId)).at(-1) as LedgerEvent;
      const received = (await eventsOf(to.walletId)).at(-1) as LedgerEvent;
      expect(sent.type).toBe('TransferCompleted');
      expect(received.type).toBe('TransferReceived');
      expect(received.payload.operationId).toBe(sent.payload.operationId);

      const entries = await ctx.dataSource
        .getRepository(LedgerEntry)
        .findBy({ operationId: sent.payload.operationId as string });
      expect(entries.map((e) => [e.accountId, e.amount, e.currency]).sort()).toEqual(
        [
          [from.walletId, '-40.00', 'USD'],
          [to.walletId, '40.00', 'USD'],
        ].sort(),
      );
    });

    it("credits a recipient without touching the recipient's own holds", async () => {
      const from = await account('USD', 100);
      const to = await account('USD', 50);
      await place(to, 30).expect(201);
      const hold = await place(from, 100).expect(201);

      await capture(hold.body.id, to, 100).expect(201);

      expect(await wallet(to.walletId)).toMatchObject({ balance: '150.00', held: '30.00' });
      expect(await wallet(from.walletId)).toMatchObject({ balance: '0.00', held: '0.00' });
    });

    it('converts across currencies through FX accounts', async () => {
      const from = await account('USD', 100);
      const to = await account('EUR');
      const hold = await place(from, 100).expect(201);

      await capture(hold.body.id, to, 92.34).expect(201);

      expect(await wallet(from.walletId)).toMatchObject({ balance: '0.00', held: '0.00' });
      expect(await wallet(to.walletId)).toMatchObject({ balance: '92.34', currency: 'EUR' });
      const operationId = (await ctx.dataSource.getRepository(Hold).findOneByOrFail({ id: hold.body.id }))
        .operationId as string;
      const entries = await ctx.dataSource.getRepository(LedgerEntry).findBy({ operationId });
      expect(entries.map((e) => [e.accountId, e.amount, e.currency]).sort()).toEqual(
        [
          [from.walletId, '-100.00', 'USD'],
          ['fx:USD', '100.00', 'USD'],
          ['fx:EUR', '-92.34', 'EUR'],
          [to.walletId, '92.34', 'EUR'],
        ].sort(),
      );
    });

    it('treats a repeated capture as the same capture', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);

      const first = await capture(hold.body.id, to, 40).expect(201);
      const second = await capture(hold.body.id, to, 40).expect(201);

      expect(second.body).toEqual(first.body);
      expect((await wallet(to.walletId)).balance).toBe('40.00');
      expect((await wallet(from.walletId)).balance).toBe('60.00');
    });

    it('rejects a capture that repeats a hold id with different parameters', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const other = await account('USD');
      const hold = await place(from, 40).expect(201);
      await capture(hold.body.id, to, 40).expect(201);

      await capture(hold.body.id, other, 40).expect(409);
      expect((await wallet(other.walletId)).balance).toBe('0.00');
    });

    it('refuses to capture a released hold', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);
      await release(hold.body.id).expect(201);

      await capture(hold.body.id, to, 40).expect(409);
      expect((await wallet(to.walletId)).balance).toBe('0.00');
    });

    it('refuses invalid captures and keeps the hold in place', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);

      await capture(hold.body.id, from, 40).expect(400);
      await capture(hold.body.id, to, 39.99).expect(400);
      await ctx
        .internal('post', `/holds/${hold.body.id}/capture`, {
          toWalletId: randomUUID(),
          amount: 40,
          currency: 'USD',
        })
        .expect(404);
      await capture(randomUUID(), to, 40).expect(404);

      expect(
        (await ctx.dataSource.getRepository(Hold).findOneByOrFail({ id: hold.body.id })).status,
      ).toBe('placed');
      expect(await wallet(from.walletId)).toMatchObject({ balance: '100.00', held: '40.00' });
    });

    it('refuses to credit a wallet whose currency differs from the requested one', async () => {
      const from = await account('USD', 100);
      const to = await account('UAH');
      const hold = await place(from, 100).expect(201);

      await capture(hold.body.id, to, 92.34, 'EUR').expect(400);

      expect((await wallet(to.walletId)).balance).toBe('0.00');
      expect(
        (await ctx.dataSource.getRepository(Hold).findOneByOrFail({ id: hold.body.id })).status,
      ).toBe('placed');
    });

    it('treats a repeated capture in a different currency as a conflict', async () => {
      const from = await account('USD', 100);
      const to = await account('EUR');
      const hold = await place(from, 100).expect(201);
      await capture(hold.body.id, to, 92.34).expect(201);

      await capture(hold.body.id, to, 92.34, 'UAH').expect(409);
    });

    it('records the sender as the actor of both sides of a transfer', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 10).expect(201);
      await capture(hold.body.id, to, 10).expect(201);

      const sent = (await eventsOf(from.walletId)).at(-1) as LedgerEvent;
      const received = (await eventsOf(to.walletId)).at(-1) as LedgerEvent;
      expect(sent.metadata).toEqual({ actorId: from.userId });
      expect(received.metadata).toEqual({ actorId: from.userId });
    });

    it('captures a hold exactly once under concurrent captures', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => capture(hold.body.id, to, 40)),
      );

      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(201));
      expect((await wallet(to.walletId)).balance).toBe('40.00');
      const completed = (await eventsOf(from.walletId)).filter((e) => e.type === 'TransferCompleted');
      expect(completed).toHaveLength(1);
    });

    it('lets exactly one of a concurrent capture and release win', async () => {
      const from = await account('USD', 100);
      const to = await account('USD');
      const hold = await place(from, 40).expect(201);

      const [captured, released] = await Promise.all([
        capture(hold.body.id, to, 40),
        release(hold.body.id),
      ]);

      expect([captured.status, released.status].sort()).toEqual([201, 409]);
      const sender = await wallet(from.walletId);
      const recipient = await wallet(to.walletId);
      expect(sender.held).toBe('0.00');
      expect(toCents(sender.balance) + toCents(recipient.balance)).toBe(10000n);
    });

    it('settles opposite transfers between the same wallets concurrently without deadlocks', async () => {
      const a = await account('USD', 500);
      const b = await account('USD', 500);

      const transfer = async (from: Account, to: Account) => {
        const hold = await place(from, 5);
        if (hold.status !== 201) return hold.status;
        return (await capture(hold.body.id, to, 5)).status;
      };
      const statuses = await Promise.all(
        Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? transfer(a, b) : transfer(b, a))),
      );

      expect(statuses).toEqual(Array(30).fill(201));
      expect(await wallet(a.walletId)).toMatchObject({ balance: '500.00', held: '0.00' });
      expect(await wallet(b.walletId)).toMatchObject({ balance: '500.00', held: '0.00' });
    });
  });

  describe('ledger invariants after all of the above', () => {
    it('keeps every wallet projection equal to its rebuilt event stream', async () => {
      const wallets = await ctx.dataSource.getRepository(Wallet).find();
      expect(wallets.length).toBeGreaterThan(20);
      for (const w of wallets) {
        const events = (await eventsOf(w.id)).map(
          (e) =>
            ({
              type: e.type,
              schemaVersion: e.schemaVersion,
              streamVersion: e.streamVersion,
              payload: e.payload,
            }) as unknown as StoredEvent,
        );
        const rebuilt = foldWallet(events);
        expect({ id: w.id, balance: formatCents(rebuilt.balance), held: formatCents(rebuilt.held) }).toEqual({
          id: w.id,
          balance: w.balance,
          held: w.held,
        });
      }
    });

    it('keeps held amounts equal to the sum of placed holds', async () => {
      const mismatches = await ctx.dataSource.query(`
        SELECT w.id, w.held, COALESCE(SUM(h.amount) FILTER (WHERE h.status = 'placed'), 0) AS placed
          FROM wallets w LEFT JOIN holds h ON h."walletId" = w.id
         GROUP BY w.id, w.held
        HAVING w.held <> COALESCE(SUM(h.amount) FILTER (WHERE h.status = 'placed'), 0)`);
      expect(mismatches).toEqual([]);
    });

    it('lets the database itself refuse a projection that holds more than the balance', async () => {
      const from = await account('USD', 10);
      for (const sql of [
        `UPDATE wallets SET held = balance + 1 WHERE id = '${from.walletId}'`,
        `UPDATE wallets SET balance = -1 WHERE id = '${from.walletId}'`,
        `UPDATE wallets SET held = -1 WHERE id = '${from.walletId}'`,
      ]) {
        await expect(ctx.dataSource.query(sql)).rejects.toThrow('check constraint');
      }
    });

    it('balances every operation and the whole ledger per currency', async () => {
      const unbalanced = await ctx.dataSource.query(`
        SELECT "operationId", currency FROM ledger_entries
         GROUP BY "operationId", currency HAVING SUM(amount) <> 0`);
      expect(unbalanced).toEqual([]);
      const totals: { total: string }[] = await ctx.dataSource.query(
        'SELECT SUM(amount)::text AS total FROM ledger_entries GROUP BY currency',
      );
      expect(totals.map((t) => toCents(t.total))).toEqual(totals.map(() => 0n));
    });
  });
});
