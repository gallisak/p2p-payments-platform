import { randomUUID } from 'crypto';
import { Client } from 'pg';
import {
  activity,
  blockWallet,
  createTransfer,
  eventsOf,
  openWallet,
  reconciliation,
  registerUser,
  settled,
  transfer,
  until,
  walletIn,
} from '../src/client';

const LEDGER_DB_URL = process.env.LEDGER_DB_URL ?? 'postgres://ledger:ledger@localhost:5433/ledger';

describe('Transfers across ledger, payments and notifications (e2e)', () => {
  it('converts currencies and keeps both balances, both event logs and both feeds consistent', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const from = await openWallet(alice, 'USD', 100);

    const created = await createTransfer(alice, { fromWalletId: from, toWalletIdentifier: bob.email.toUpperCase(), amount: 50, currency: 'EUR' });
    expect(created.status).toBe(202);
    const done = await settled(alice, created.body.id);

    expect(done).toMatchObject({ status: 'completed', fromCurrency: 'USD', toCurrency: 'EUR', amount: '50.00', creditAmount: '46.00', rate: '0.920000' });
    expect(done.steps.map((s: { step: string }) => s.step)).toEqual(['check', 'hold', 'confirm', 'capture']);
    expect(await walletIn(alice, 'USD')).toMatchObject({ balance: '50.00', held: '0.00' });
    const bobEur = await walletIn(bob, 'EUR');
    expect(bobEur).toMatchObject({ id: done.toWalletId, balance: '46.00', held: '0.00' });

    const sent = (await eventsOf(from)).map((e) => e.type);
    expect(sent).toEqual(['WalletOpened', 'MoneyDeposited', 'HoldPlaced', 'TransferCompleted']);
    const completed = (await eventsOf(from)).at(-1)!;
    const received = (await eventsOf(bobEur!.id)).at(-1)!;
    expect(completed.payload).toMatchObject({ holdId: done.id, amount: '50.00', creditAmount: '46.00', creditCurrency: 'EUR' });
    expect(received).toMatchObject({ type: 'TransferReceived', payload: { operationId: completed.payload.operationId, amount: '46.00', currency: 'EUR' } });

    const aliceFeed = await until(async () => {
      const feed = await activity(alice);
      return feed.items.some((a) => a.type === 'transfer_sent') ? feed : undefined;
    }, 20_000, 'alice feed');
    const bobFeed = await until(async () => {
      const feed = await activity(bob);
      return feed.items.length > 0 ? feed : undefined;
    }, 20_000, 'bob feed');
    expect(aliceFeed.items.map((a) => a.type)).toEqual(['transfer_sent', 'deposit']);
    expect(bobFeed.items).toEqual([
      expect.objectContaining({ type: 'transfer_received', data: expect.objectContaining({ amount: '46.00', currency: 'EUR', fromWalletId: from }) }),
    ]);
    expect((await reconciliation()).ok).toBe(true);
  });

  it('releases the reserved funds when the recipient is blocked after the hold was placed', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const from = await openWallet(alice, 'USD', 100);
    const to = await openWallet(bob, 'USD');
    const db = new Client({ connectionString: LEDGER_DB_URL });
    const observer = new Client({ connectionString: LEDGER_DB_URL });
    await Promise.all([db.connect(), observer.connect()]);
    let created;
    try {
      await db.query('BEGIN');
      await db.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [from]);

      created = await createTransfer(alice, { fromWalletId: from, toWalletIdentifier: bob.email, amount: 30, currency: 'USD' });
      expect(created.status).toBe(202);
      await until(async () => {
        const { rows } = await observer.query(
          `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'active'
              AND wait_event_type = 'Lock' AND query ILIKE '%FROM "wallets"%'`,
        );
        return rows[0].waiting > 0 ? true : undefined;
      }, 10_000, 'the hold to wait for the sender wallet');
      await blockWallet(to, 'blocked mid-transfer');
    } finally {
      await db.query('COMMIT').catch(() => undefined);
      await Promise.all([db.end(), observer.end()]);
    }

    const done = await settled(alice, created.body.id);

    expect(done).toMatchObject({ status: 'failed', failureReason: 'recipient_blocked' });
    const steps = done.steps.map((s: { step: string; outcome: string }) => `${s.step}:${s.outcome}`);
    expect(steps).toContain('hold:succeeded');
    expect(steps.slice(-2)).toEqual(['confirm:failed', 'compensate:succeeded']);
    expect(await walletIn(alice, 'USD')).toMatchObject({ balance: '100.00', held: '0.00' });
    expect(await walletIn(bob, 'USD')).toMatchObject({ balance: '0.00', held: '0.00', blocked: true });
    expect((await eventsOf(from)).map((e) => e.type)).toEqual(['WalletOpened', 'MoneyDeposited', 'HoldPlaced', 'HoldReleased']);
    const failed = await until(async () => {
      const feed = await activity(alice, '?type=transfer_failed');
      return feed.items[0];
    }, 20_000, 'the failure in the feed');
    expect(failed.data).toMatchObject({ transferId: done.id, failureReason: 'recipient_blocked' });
    expect((await reconciliation()).ok).toBe(true);
  });

  it('creates a transfer exactly once for concurrent requests with the same Idempotency-Key', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const from = await openWallet(alice, 'USD', 100);
    const key = randomUUID();
    const body = { fromWalletId: from, toWalletIdentifier: bob.email, amount: 10, currency: 'USD' };

    const responses = await Promise.all(Array.from({ length: 20 }, () => createTransfer(alice, body, key)));

    expect(responses.map((r) => r.status).sort()).toEqual([...Array(19).fill(200), 202]);
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const done = await settled(alice, [...ids][0] as string);
    expect(done.status).toBe('completed');

    const again = await createTransfer(alice, body, key);
    expect(again).toMatchObject({ status: 200, body: { id: done.id, status: 'completed' } });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await createTransfer(alice, { ...body, amount: 11 }, key)).status).toBe(422);

    expect(await walletIn(alice, 'USD')).toMatchObject({ balance: '90.00', held: '0.00' });
    expect(await walletIn(bob, 'USD')).toMatchObject({ balance: '10.00' });
    expect((await eventsOf(from)).filter((e) => e.type === 'HoldPlaced')).toHaveLength(1);
  });

  it('hides a transfer from anyone but its sender', async () => {
    const alice = await registerUser('alice');
    const mallory = await registerUser('mallory');
    const from = await openWallet(alice, 'USD', 10);
    const created = await createTransfer(alice, { fromWalletId: from, toWalletIdentifier: mallory.email, amount: 1, currency: 'USD' });
    await settled(alice, created.body.id);

    await expect(transfer(mallory, created.body.id)).rejects.toThrow('404');
    const stolen = await createTransfer(mallory, { fromWalletId: from, toWalletIdentifier: mallory.email, amount: 5, currency: 'USD' });
    expect(await settled(mallory, stolen.body.id)).toMatchObject({ status: 'failed', failureReason: 'source_wallet_not_found' });
    expect(await walletIn(alice, 'USD')).toMatchObject({ balance: '9.00', held: '0.00' });
  });
});
