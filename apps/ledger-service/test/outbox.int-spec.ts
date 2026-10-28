import { randomUUID } from 'crypto';
import { In, IsNull, Not } from 'typeorm';
import { LedgerEvent } from '../src/ledger/entities/ledger-event.entity';
import { OutboxMessage } from '../src/outbox/outbox-message.entity';
import { OutboxRelay } from '../src/outbox/outbox-relay.service';
import Redis from 'ioredis';
import { createRedis } from '../src/outbox/redis.provider';
import { IntegrationApp, createIntegrationApp } from './support/integration-app';

interface Account {
  token: string;
  userId: string;
  walletId: string;
}

describe('Transactional outbox to Redis Streams (integration)', () => {
  let ctx: IntegrationApp;

  beforeAll(async () => {
    ctx = await createIntegrationApp({ relay: false });
  });

  const relays: OutboxRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.onModuleDestroy()));
  });

  afterAll(async () => {
    await ctx.close();
  });

  const relay = (redis: Redis = createRedis(process.env.REDIS_URL as string)) => {
    const created = new OutboxRelay(ctx.dataSource, redis);
    relays.push(created);
    return created;
  };

  const unreachableRedis = () =>
    new Redis('redis://localhost:1', {
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });

  const drain = async (r: OutboxRelay) => {
    let total = 0;
    for (;;) {
      const published = await r.publishPending();
      if (published === 0) return total;
      total += published;
    }
  };

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
    return { ...user, walletId };
  }

  const pending = () =>
    ctx.dataSource.getRepository(OutboxMessage).countBy({ publishedAt: IsNull() });

  it('writes an outbox message in the same transaction as every ledger event', async () => {
    const from = await account('USD', 100);
    const to = await account('USD');
    const hold = await ctx
      .internal('post', '/holds', { holdId: randomUUID(), walletId: from.walletId, ownerId: from.userId, amount: 40 })
      .expect(201);
    await ctx
      .internal('post', `/holds/${hold.body.id}/capture`, { toWalletId: to.walletId, amount: 40, currency: 'USD' })
      .expect(201);

    const events = await ctx.dataSource.getRepository(LedgerEvent).find();
    const messages = await ctx.dataSource.getRepository(OutboxMessage).find();
    expect(messages.map((m) => m.eventId).sort()).toEqual(events.map((e) => e.eventId).sort());
  });

  it('writes nothing to the outbox when the operation is rejected', async () => {
    const user = await account('USD', 10);
    const before = await ctx.dataSource.getRepository(OutboxMessage).count();

    await ctx
      .http()
      .post(`/wallets/${user.walletId}/withdraw`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ amount: 10.01 })
      .expect(400);

    expect(await ctx.dataSource.getRepository(OutboxMessage).count()).toBe(before);
  });

  it('publishes pending messages with the full envelope and marks them published', async () => {
    const from = await account('USD', 100);
    const to = await account('EUR');
    const hold = await ctx
      .internal('post', '/holds', { holdId: randomUUID(), walletId: from.walletId, ownerId: from.userId, amount: 50 })
      .expect(201);
    await ctx
      .internal('post', `/holds/${hold.body.id}/capture`, { toWalletId: to.walletId, amount: 46.17, currency: 'EUR' })
      .expect(201);

    await drain(relay());

    expect(await pending()).toBe(0);
    const events = await ctx.published();
    const ofSender = events.filter((e) => e.envelope.streamId === from.walletId);
    expect(ofSender.map((e) => e.type)).toEqual([
      'WalletOpened',
      'MoneyDeposited',
      'HoldPlaced',
      'TransferCompleted',
    ]);
    expect(ofSender.map((e) => e.envelope.wallet)).toEqual([
      { currency: 'USD', balance: '0.00', held: '0.00', blocked: false },
      { currency: 'USD', balance: '100.00', held: '0.00', blocked: false },
      { currency: 'USD', balance: '100.00', held: '50.00', blocked: false },
      { currency: 'USD', balance: '50.00', held: '0.00', blocked: false },
    ]);
    const received = events.find(
      (e) => e.envelope.streamId === to.walletId && e.type === 'TransferReceived',
    );
    expect(received?.envelope).toMatchObject({
      ownerId: to.userId,
      metadata: { actorId: from.userId },
      wallet: { currency: 'EUR', balance: '46.17' },
      payload: { fromWalletId: from.walletId, amount: '46.17', currency: 'EUR' },
    });
    for (const e of events) {
      expect(e.eventId).toBe(e.envelope.eventId);
      expect(e.envelope).toEqual(
        expect.objectContaining({
          schemaVersion: expect.any(Number),
          streamVersion: expect.any(Number),
          occurredAt: expect.any(String),
        }),
      );
    }
  });

  it('publishes each message only once across repeated runs', async () => {
    await account('USD', 5);
    const r = relay();
    await drain(r);
    const count = (await ctx.published()).length;

    expect(await r.publishPending()).toBe(0);
    expect((await ctx.published()).length).toBe(count);
  });

  it('keeps the events of one wallet in order in the stream', async () => {
    const user = await account('USD', 100);
    for (let i = 0; i < 15; i++) {
      await ctx
        .http()
        .post(`/wallets/${user.walletId}/${i % 2 ? 'withdraw' : 'deposit'}`)
        .set('Authorization', `Bearer ${user.token}`)
        .send({ amount: 1 })
        .expect(201);
    }

    await drain(relay());

    const versions = (await ctx.published())
      .filter((e) => e.envelope.streamId === user.walletId)
      .map((e) => e.envelope.streamVersion);
    expect(versions).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
  });

  it('keeps messages while Redis is unavailable and delivers them once it is back', async () => {
    await drain(relay());
    const user = await account('USD', 30);
    const before = (await ctx.published()).length;

    const down = relay(unreachableRedis());
    await expect(down.publishPending()).rejects.toThrow();
    await expect(down.publishPending()).rejects.toThrow();

    expect(await pending()).toBe(2);
    expect((await ctx.published()).length).toBe(before);

    await drain(relay());

    expect(await pending()).toBe(0);
    const delivered = (await ctx.published()).filter(
      (e) => e.envelope.streamId === user.walletId,
    );
    expect(delivered.map((e) => e.type)).toEqual(['WalletOpened', 'MoneyDeposited']);
  });

  it('publishes nothing from a batch that Redis rejects and retries it later', async () => {
    await drain(relay());
    const user = await account('USD', 3);
    const before = (await ctx.published()).length;
    await ctx.redis.rename(ctx.stream, `${ctx.stream}.saved`);
    await ctx.redis.set(ctx.stream, 'not a stream');

    await expect(relay().publishPending()).rejects.toThrow('WRONGTYPE');
    expect(await pending()).toBe(2);

    await ctx.redis.del(ctx.stream);
    await ctx.redis.rename(`${ctx.stream}.saved`, ctx.stream);
    await drain(relay());

    expect(await pending()).toBe(0);
    const delivered = (await ctx.published()).slice(before);
    expect(delivered.map((e) => [e.envelope.streamId, e.type])).toEqual([
      [user.walletId, 'WalletOpened'],
      [user.walletId, 'MoneyDeposited'],
    ]);
  });

  it('purges only published messages older than the retention period', async () => {
    const r = relay();
    await drain(r);
    await account('USD', 2);
    const repo = ctx.dataSource.getRepository(OutboxMessage);
    const published = await repo.find({ where: { publishedAt: Not(IsNull()) }, order: { id: 'ASC' } });
    const old = published.slice(0, 3).map((m) => m.id);
    await ctx.dataSource.query(
      `UPDATE outbox SET "publishedAt" = now() - interval '2 days' WHERE id = ANY($1)`,
      [old],
    );
    const unpublishedBefore = await pending();

    const purged = await r.purgePublished(24 * 3_600_000);

    expect(purged).toBe(3);
    expect(await repo.countBy({ id: In(old) })).toBe(0);
    expect(await pending()).toBe(unpublishedBefore);
    expect(await repo.count()).toBeGreaterThan(0);
  });

  it('publishes every message exactly once with several relays running at the same time', async () => {
    await drain(relay());
    const users = await Promise.all(Array.from({ length: 6 }, () => account('USD', 10)));
    const before = (await ctx.published()).length;
    const expected = await pending();

    const published = await Promise.all(Array.from({ length: 4 }, () => drain(relay())));

    expect(published.reduce((a, b) => a + b, 0)).toBe(expected);
    const events = (await ctx.published()).slice(before);
    expect(events).toHaveLength(expected);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(expected);
    expect(events.filter((e) => users.some((u) => u.walletId === e.envelope.streamId))).toHaveLength(12);
  });

  it('drains a backlog larger than one batch', async () => {
    await drain(relay());
    const original = process.env.OUTBOX_BATCH_SIZE;
    process.env.OUTBOX_BATCH_SIZE = '3';
    try {
      const user = await account('USD', 1);
      for (let i = 0; i < 9; i++) {
        await ctx
          .http()
          .post(`/wallets/${user.walletId}/deposit`)
          .set('Authorization', `Bearer ${user.token}`)
          .send({ amount: 1 })
          .expect(201);
      }
      const r = relay();
      expect(await r.publishPending()).toBe(3);
      await drain(r);
      expect(await pending()).toBe(0);
    } finally {
      if (original === undefined) delete process.env.OUTBOX_BATCH_SIZE;
      else process.env.OUTBOX_BATCH_SIZE = original;
    }
  });

  it('delivers new events in the background once the relay is started', async () => {
    await drain(relay());
    const background = relay();
    process.env.OUTBOX_RELAY_ENABLED = 'true';
    try {
      await background.onApplicationBootstrap();
      const user = await account('USD', 7);

      let delivered: string[] = [];
      for (let i = 0; i < 100 && delivered.length < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        delivered = (await ctx.published())
          .filter((e) => e.envelope.streamId === user.walletId)
          .map((e) => e.type);
      }
      expect(delivered).toEqual(['WalletOpened', 'MoneyDeposited']);
    } finally {
      process.env.OUTBOX_RELAY_ENABLED = 'false';
    }
  });
});
