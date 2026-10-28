import { QueryFailedError } from 'typeorm';
import { Wallet } from '../src/wallets/entities/wallet.entity';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { LedgerEntry } from '../src/ledger/entities/ledger-entry.entity';
import { EventStore } from '../src/ledger/event-store.service';
import { AppendOnlyGuard } from '../src/ledger/append-only.guard';
import { StoredEvent } from '../src/ledger/ledger-events';
import { formatCents, toCents } from '../src/ledger/money';
import { foldBalance } from '../src/ledger/wallet-projection';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

function seededRandom(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

describe('Event-sourced ledger on Postgres (integration)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  const send = (
    token: string,
    walletId: string,
    action: 'deposit' | 'withdraw',
    amount: number,
  ) =>
    ctx
      .http()
      .post(`/wallets/${walletId}/${action}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ amount });

  const eventsOf = (streamId: string) =>
    ctx.dataSource
      .getRepository(LedgerEvent)
      .find({ where: { streamId }, order: { streamVersion: 'ASC' } });

  const asStored = (events: LedgerEvent[]) =>
    events.map(
      (e) =>
        ({
          type: e.type,
          schemaVersion: e.schemaVersion,
          streamVersion: e.streamVersion,
          payload: e.payload,
        }) as unknown as StoredEvent,
    );

  it('records every operation as an event with an increasing stream version', async () => {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token);
    await send(user.token, walletId, 'deposit', 100).expect(201);
    await send(user.token, walletId, 'withdraw', 30.5).expect(201);

    const events = await eventsOf(walletId);

    expect(events.map((e) => [e.streamVersion, e.type])).toEqual([
      [1, 'WalletOpened'],
      [2, 'MoneyDeposited'],
      [3, 'MoneyWithdrawn'],
    ]);
    expect(events.every((e) => e.schemaVersion === 1)).toBe(true);
    const wallet = await ctx.dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: walletId });
    expect(wallet.version).toBe(3);
    expect(wallet.balance).toBe('69.50');
  });

  it('does not record anything when an operation is rejected', async () => {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token);
    await send(user.token, walletId, 'deposit', 10).expect(201);
    const entriesBefore = await ctx.dataSource.getRepository(LedgerEntry).count();

    await send(user.token, walletId, 'withdraw', 10.01).expect(400);

    expect(await eventsOf(walletId)).toHaveLength(2);
    expect(await ctx.dataSource.getRepository(LedgerEntry).count()).toBe(
      entriesBefore,
    );
  });

  it('rejects a second event with the same stream version', async () => {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token);
    const store = ctx.app.get(EventStore);

    const appendAtVersion1 = () =>
      ctx.dataSource.transaction((manager) =>
        store.append(manager, {
          streamId: walletId,
          expectedVersion: 0,
          type: 'WalletOpened',
          payload: { ownerId: user.userId, currency: 'USD' },
        }),
      );

    const error = await appendAtVersion1().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(QueryFailedError);
    expect((error as QueryFailedError).driverError).toMatchObject({
      code: '23505',
      detail: expect.stringContaining('"streamId", "streamVersion"'),
    });
    expect(await eventsOf(walletId)).toHaveLength(1);
  });

  it('refuses to modify, delete or truncate recorded events and postings', async () => {
    const user = await ctx.registerUser();
    const walletId = await ctx.openWallet(user.token);
    await send(user.token, walletId, 'deposit', 25).expect(201);
    const statements = [
      `UPDATE ledger_events SET payload = '{}' WHERE "streamId" = '${walletId}'`,
      `DELETE FROM ledger_events WHERE "streamId" = '${walletId}'`,
      'TRUNCATE ledger_events',
      `UPDATE ledger_entries SET amount = 0 WHERE "accountId" = '${walletId}'`,
      `DELETE FROM ledger_entries WHERE "accountId" = '${walletId}'`,
      'TRUNCATE ledger_entries',
    ];

    for (const sql of statements) {
      await expect(ctx.dataSource.query(sql)).rejects.toThrow('is append-only');
    }
    expect(await eventsOf(walletId)).toHaveLength(2);
  });

  it('installs the append-only triggers safely from concurrent service instances', async () => {
    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          new AppendOnlyGuard(ctx.dataSource).onModuleInit(),
        ),
      ),
    ).resolves.toBeDefined();
  });

  describe('after a random mix of operations', () => {
    let walletIds: string[];
    const outcomes: { action: string; status: number; message?: string }[] = [];

    beforeAll(async () => {
      const random = seededRandom(42);
      const users = await Promise.all(
        Array.from({ length: 4 }, () => ctx.registerUser()),
      );
      walletIds = [];
      const owners = new Map<string, string>();
      for (const user of users) {
        for (const currency of ['USD', 'EUR', 'UAH']) {
          const id = await ctx.openWallet(user.token, currency);
          walletIds.push(id);
          owners.set(id, user.token);
        }
      }
      for (let round = 0; round < 15; round++) {
        const batch = await Promise.all(
          walletIds.map(async (id) => {
            const amount = (Math.floor(random() * 5000) + 1) / 100;
            const action = random() < 0.6 ? 'deposit' : 'withdraw';
            const res = await send(owners.get(id) as string, id, action, amount);
            return { action, status: res.status, message: res.body.message };
          }),
        );
        outcomes.push(...batch);
      }
    });

    it('executes every generated operation or rejects it only for lack of funds', () => {
      const unexpected = outcomes.filter(
        (o) =>
          !(o.status === 201) &&
          !(
            o.action === 'withdraw' &&
            o.status === 400 &&
            o.message === 'Недостатньо коштів'
          ),
      );
      expect(unexpected).toEqual([]);
      expect(outcomes.filter((o) => o.status === 201).length).toBeGreaterThan(120);
      expect(
        outcomes.filter((o) => o.action === 'withdraw' && o.status === 201).length,
      ).toBeGreaterThan(20);
    });

    it('keeps every projection equal to the balance rebuilt from its events', async () => {
      for (const id of walletIds) {
        const wallet = await ctx.dataSource
          .getRepository(Wallet)
          .findOneByOrFail({ id });
        const rebuilt = foldBalance(asStored(await eventsOf(id)));
        expect(formatCents(rebuilt)).toBe(wallet.balance);
      }
    });

    it('keeps every projection equal to the sum of its postings', async () => {
      for (const id of walletIds) {
        const wallet = await ctx.dataSource
          .getRepository(Wallet)
          .findOneByOrFail({ id });
        const entries = await ctx.dataSource
          .getRepository(LedgerEntry)
          .findBy({ accountId: id });
        const sum = entries.reduce((s, e) => s + toCents(e.amount), 0n);
        expect(formatCents(sum)).toBe(wallet.balance);
      }
    });

    it('balances every single operation to zero', async () => {
      const unbalanced = await ctx.dataSource.query(
        `SELECT "operationId", SUM(amount) AS total, COUNT(*) AS postings
           FROM ledger_entries
          GROUP BY "operationId"
         HAVING SUM(amount) <> 0 OR COUNT(*) < 2`,
      );
      expect(unbalanced).toEqual([]);
    });

    it('balances the whole ledger to zero in every currency', async () => {
      const totals: { currency: string; total: string }[] =
        await ctx.dataSource.query(
          `SELECT currency, SUM(amount)::text AS total
             FROM ledger_entries
            GROUP BY currency`,
        );
      expect(totals.length).toBeGreaterThan(0);
      for (const { total } of totals) {
        expect(toCents(total)).toBe(0n);
      }
    });

    it('never lets a wallet balance go negative', async () => {
      const negative = await ctx.dataSource
        .getRepository(Wallet)
        .createQueryBuilder('w')
        .where('w.balance < 0')
        .getCount();
      expect(negative).toBe(0);
    });
  });
});
