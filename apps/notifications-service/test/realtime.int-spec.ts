import { randomUUID } from 'crypto';
import { Socket } from 'socket.io-client';
import { depositPayload, ledgerEnvelope, paymentsEnvelope } from './support/envelopes';
import { NotificationsApp, collect, createNotificationsApp, nextEvent } from './support/integration-app';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Snapshot {
  wallets: { walletId: string; balance: string; streamVersion: number }[];
  transfers: { transferId: string; status: string }[];
  activity: { id: string; type: string; data: Record<string, unknown> }[];
  activityCursor: string | null;
}

describe('Real-time notifications and activity feed (integration)', () => {
  let ctx: NotificationsApp;

  beforeAll(async () => {
    ctx = await createNotificationsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function connected(userId: string): Promise<{ socket: Socket; snapshot: Snapshot }> {
    const socket = ctx.connect(await ctx.token(userId));
    const snapshot = await nextEvent<Snapshot>(socket, 'snapshot');
    return { socket, snapshot };
  }

  const deposit = (ownerId: string, walletId: string, version: number, balance: string, amount = '10.00') =>
    ledgerEnvelope({
      type: 'MoneyDeposited',
      ownerId,
      walletId,
      streamVersion: version,
      wallet: { balance },
      payload: depositPayload(amount),
    });

  describe('WebSocket', () => {
    it('refuses a connection without a valid access token', async () => {
      for (const token of [null, 'not-a-jwt', await ctx.token('not-a-uuid')]) {
        const socket = ctx.connect(token);
        const unauthorized = nextEvent(socket, 'unauthorized');
        const disconnected = nextEvent(socket, 'disconnect');
        await expect(unauthorized).resolves.toHaveProperty('message');
        await disconnected;
      }
    });

    it('refuses a token signed with another secret', async () => {
      const { JwtService } = await import('@nestjs/jwt');
      const forged = await new JwtService({ secret: 'someone-else' }).signAsync({ sub: randomUUID() });
      const socket = ctx.connect(forged);
      await expect(nextEvent(socket, 'unauthorized')).resolves.toBeDefined();
    });

    it('sends the current state right after connecting', async () => {
      const userId = randomUUID();
      const walletId = randomUUID();
      await ctx.publish('ledger', deposit(userId, walletId, 2, '10.00'));
      await ctx.until(async () => ((await ctx.http().get('/snapshot').set('Authorization', `Bearer ${await ctx.token(userId)}`)).body.wallets?.length ? true : undefined));

      const { snapshot } = await connected(userId);

      expect(snapshot.wallets).toEqual([expect.objectContaining({ walletId, balance: '10.00', streamVersion: 2 })]);
      expect(snapshot.activity).toEqual([expect.objectContaining({ type: 'deposit' })]);
    });

    it('pushes wallet, transfer and activity changes to their owner only', async () => {
      const alice = randomUUID();
      const bob = randomUUID();
      const a = await connected(alice);
      const b = await connected(bob);
      const bobSaw = ['wallet.updated', 'transfer.updated', 'activity.created'].map((e) => collect(b.socket, e));
      const walletId = randomUUID();
      const transferId = randomUUID();

      const wallet = nextEvent(a.socket, 'wallet.updated');
      const activity = nextEvent(a.socket, 'activity.created');
      await ctx.publish('ledger', deposit(alice, walletId, 1, '15.00', '15.00'));
      expect(await wallet).toMatchObject({ walletId, balance: '15.00', streamVersion: 1, currency: 'USD' });
      expect(await activity).toMatchObject({ type: 'deposit', data: { walletId, amount: '15.00' } });

      const transfer = nextEvent(a.socket, 'transfer.updated');
      await ctx.publish('payments', paymentsEnvelope({ type: 'TransferStepChanged', transferId, ownerId: alice, recipientId: bob, streamVersion: 2, payload: { status: 'checked' } }));
      expect(await transfer).toMatchObject({ transferId, status: 'checked', streamVersion: 2 });

      await sleep(150);
      expect(bobSaw).toEqual([[], [], []]);
    });

    it('does not push an event that was already applied', async () => {
      const userId = randomUUID();
      const { socket } = await connected(userId);
      const pushes = collect(socket, 'wallet.updated');
      const e = deposit(userId, randomUUID(), 1, '1.00', '1.00');

      await ctx.publish('ledger', e);
      await ctx.publish('ledger', e);
      await ctx.until(async () => (pushes.length > 0 ? true : undefined));
      await sleep(200);

      expect(pushes).toHaveLength(1);
    });

    it('does not push a stale wallet version, but still records its activity', async () => {
      const userId = randomUUID();
      const walletId = randomUUID();
      const { socket } = await connected(userId);
      const wallets = collect<{ streamVersion: number }>(socket, 'wallet.updated');
      const activity = collect(socket, 'activity.created');

      await ctx.publish('ledger', deposit(userId, walletId, 5, '50.00'));
      await ctx.publish('ledger', deposit(userId, walletId, 4, '40.00'));
      await ctx.until(async () => (activity.length === 2 ? true : undefined));
      await sleep(100);

      expect(wallets.map((w) => w.streamVersion)).toEqual([5]);
    });

    it('brings a reconnecting client up to date with what it missed', async () => {
      const userId = randomUUID();
      const walletId = randomUUID();
      const transferId = randomUUID();
      const first = await connected(userId);
      first.socket.disconnect();

      await ctx.publish('ledger', deposit(userId, walletId, 1, '10.00'));
      await ctx.publish('ledger', deposit(userId, walletId, 2, '20.00'));
      await ctx.publish('payments', paymentsEnvelope({ type: 'TransferCompleted', transferId, ownerId: userId, streamVersion: 6, payload: { status: 'completed' } }));
      const token = await ctx.token(userId);
      await ctx.until(async () => {
        const res = await ctx.http().get('/snapshot').set('Authorization', `Bearer ${token}`);
        return res.body.transfers?.length === 1 && res.body.wallets?.[0]?.streamVersion === 2 ? true : undefined;
      });

      const { snapshot } = await connected(userId);

      expect(snapshot.wallets).toEqual([expect.objectContaining({ walletId, balance: '20.00', streamVersion: 2 })]);
      expect(snapshot.transfers).toEqual([expect.objectContaining({ transferId, status: 'completed' })]);
      expect(snapshot.activity.map((a) => a.type)).toEqual(['deposit', 'deposit']);
    });

    it('answers an explicit resync request with the current state', async () => {
      const userId = randomUUID();
      const { socket } = await connected(userId);
      const walletId = randomUUID();
      const pushed = nextEvent(socket, 'wallet.updated');
      await ctx.publish('ledger', deposit(userId, walletId, 1, '9.00', '9.00'));
      await pushed;

      const snapshot = (await socket.timeout(5_000).emitWithAck('snapshot')) as Snapshot;

      expect(snapshot.wallets).toEqual([expect.objectContaining({ walletId, balance: '9.00' })]);
    });

    it('ends the session when the access token expires', async () => {
      const socket = ctx.connect(await ctx.token(randomUUID(), 1));
      await nextEvent(socket, 'snapshot');
      const expired = nextEvent(socket, 'session.expired', 3_000);
      const disconnected = nextEvent(socket, 'disconnect', 3_500);

      await expect(expired).resolves.toHaveProperty('message');
      await disconnected;
      expect(socket.connected).toBe(false);
    });
  });

  describe('activity feed API', () => {
    it('requires authentication', async () => {
      await ctx.http().get('/activity').expect(401);
      await ctx.http().get('/snapshot').expect(401);
      await ctx.http().get('/activity').set('Authorization', `Bearer ${await ctx.token('nope')}`).expect(401);
    });

    it('pages through the feed newest first and filters by type', async () => {
      const userId = randomUUID();
      const walletId = randomUUID();
      const base = Date.parse('2026-10-29T08:00:00Z');
      const types = ['MoneyDeposited', 'MoneyWithdrawn', 'MoneyDeposited', 'MoneyDeposited', 'MoneyWithdrawn'];
      for (const [i, type] of types.entries()) {
        await ctx.publish('ledger', ledgerEnvelope({
          type,
          ownerId: userId,
          walletId,
          streamVersion: i + 1,
          occurredAt: new Date(base + (i % 2 === 0 ? i : 4 - i) * 1_000).toISOString(),
          payload: depositPayload(`${i + 1}.00`),
        }));
      }
      const token = await ctx.token(userId);
      const get = (query: string) => ctx.http().get(`/activity${query}`).set('Authorization', `Bearer ${token}`);
      await ctx.until(async () => ((await get('')).body.items.length === 5 ? true : undefined));

      const all = (await get('?limit=100').expect(200)).body.items as { occurredAt: string; data: { amount: string } }[];
      const times = all.map((a) => a.occurredAt);
      expect(times).toEqual([...times].sort().reverse());

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: { items: { id: string }[]; nextCursor: string | null } } = await get(`?limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200);
        expect(page.body.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.body.items.map((a) => a.id));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);

      const withdrawals = (await get('?type=withdrawal').expect(200)).body.items as { type: string }[];
      expect(withdrawals.map((a) => a.type)).toEqual(['withdrawal', 'withdrawal']);
      expect((await get('?type=withdrawal,deposit').expect(200)).body.items).toHaveLength(5);
      expect((await get('?type=transfer_failed').expect(200)).body).toEqual({ items: [], nextCursor: null });
    });

    it('validates the query', async () => {
      const token = await ctx.token(randomUUID());
      const get = (query: string) => ctx.http().get(`/activity${query}`).set('Authorization', `Bearer ${token}`);

      await get('?type=bribe').expect(400);
      await get('?limit=0').expect(400);
      await get('?limit=101').expect(400);
      await get('?cursor=garbage').expect(400);
    });

    it('treats the user id in the token case-insensitively', async () => {
      const userId = randomUUID();
      await ctx.publish('ledger', deposit(userId, randomUUID(), 1, '2.00', '2.00'));
      const upper = await ctx.token(userId.toUpperCase());
      await ctx.until(async () => ((await ctx.http().get('/activity').set('Authorization', `Bearer ${upper}`)).body.items.length === 1 ? true : undefined));

      const { snapshot } = await connected(userId.toUpperCase());

      expect(snapshot.activity).toHaveLength(1);
    });

    it('shows each user only their own feed', async () => {
      const alice = randomUUID();
      const bob = randomUUID();
      const e = deposit(alice, randomUUID(), 1, '5.00', '5.00');
      await ctx.publish('ledger', e);
      const aliceToken = await ctx.token(alice);
      await ctx.until(async () => ((await ctx.http().get('/activity').set('Authorization', `Bearer ${aliceToken}`)).body.items.length === 1 ? true : undefined));

      const bobs = await ctx.http().get('/activity').set('Authorization', `Bearer ${await ctx.token(bob)}`).expect(200);
      const bobSnapshot = await ctx.http().get('/snapshot').set('Authorization', `Bearer ${await ctx.token(bob)}`).expect(200);

      expect(bobs.body.items).toEqual([]);
      expect(bobSnapshot.body).toMatchObject({ wallets: [], transfers: [], activity: [] });
    });
  });
});
