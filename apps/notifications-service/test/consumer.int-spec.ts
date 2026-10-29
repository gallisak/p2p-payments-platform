import { randomUUID } from 'crypto';
import { Activity } from '../src/store/entities/activity.entity';
import { ProcessedEvent } from '../src/store/entities/processed-event.entity';
import { TransferSnapshot } from '../src/store/entities/transfer-snapshot.entity';
import { WalletSnapshot } from '../src/store/entities/wallet-snapshot.entity';
import { NotificationsStore } from '../src/store/notifications.store';
import { effectsOf } from '../src/events/effects';
import { parseEnvelope } from '../src/events/envelope';
import { depositPayload, ledgerEnvelope, paymentsEnvelope } from './support/envelopes';
import { NotificationsApp, createNotificationsApp } from './support/integration-app';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Event consumer on Postgres and Redis Streams (integration)', () => {
  let ctx: NotificationsApp;

  beforeAll(async () => {
    ctx = await createNotificationsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const wallets = () => ctx.dataSource.getRepository(WalletSnapshot);
  const activities = () => ctx.dataSource.getRepository(Activity);
  const transfers = () => ctx.dataSource.getRepository(TransferSnapshot);
  const walletOf = (walletId: string) =>
    ctx.until(async () => (await wallets().findOneBy({ walletId })) ?? undefined);
  const pendingCount = async (stream: string) => {
    const [count] = (await ctx.redis.xpending(stream, 'notifications')) as [number];
    return count;
  };

  it('projects a ledger event into the wallet snapshot and the owner’s feed', async () => {
    const ownerId = randomUUID();
    const walletId = randomUUID();
    const payload = depositPayload('25.00');
    const e = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, streamVersion: 2, wallet: { balance: '25.00' }, payload });

    await ctx.publish('ledger', e);

    expect(await walletOf(walletId)).toMatchObject({ ownerId, balance: '25.00', held: '0.00', streamVersion: 2 });
    expect(await activities().findBy({ userId: ownerId })).toEqual([
      expect.objectContaining({
        type: 'deposit',
        eventId: e.eventId,
        data: { walletId, operationId: payload.operationId, amount: '25.00', currency: 'USD' },
      }),
    ]);
    await ctx.until(async () => ((await pendingCount(ctx.streams.ledger)) === 0 ? true : undefined));
  });

  it('applies an event delivered twice only once', async () => {
    const ownerId = randomUUID();
    const walletId = randomUUID();
    const e = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, payload: depositPayload('5.00'), wallet: { balance: '5.00' } });

    await ctx.publish('ledger', e);
    await ctx.publish('ledger', e);
    await ctx.until(async () => ((await pendingCount(ctx.streams.ledger)) === 0 ? true : undefined));
    await walletOf(walletId);
    await sleep(100);

    expect(await activities().countBy({ eventId: e.eventId })).toBe(1);
    expect(await ctx.dataSource.getRepository(ProcessedEvent).countBy({ eventId: e.eventId })).toBe(1);
  });

  it('reports a redelivered event as a duplicate without touching any projection', async () => {
    const store = (ctx.consumer as unknown as { store: NotificationsStore }).store;
    const ownerId = randomUUID();
    const walletId = randomUUID();
    const raw = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, payload: depositPayload('4.00'), wallet: { balance: '4.00' } });
    const effects = effectsOf('ledger', parseEnvelope('ledger', JSON.stringify(raw)));

    const first = await store.apply('ledger', raw.eventId, effects);
    const again = await store.apply('ledger', raw.eventId, {
      ...effects,
      wallet: { ...(effects.wallet as NonNullable<typeof effects.wallet>), balance: '999.00', streamVersion: 99 },
    });

    expect(first).toMatchObject({ duplicate: false, wallet: expect.objectContaining({ balance: '4.00' }) });
    expect(first.activities).toHaveLength(1);
    expect(again).toEqual({ duplicate: true, wallet: null, transfer: null, activities: [] });
    expect(await walletOf(walletId)).toMatchObject({ balance: '4.00', streamVersion: 1 });
  });

  it('never moves a wallet snapshot back to an older version', async () => {
    const ownerId = randomUUID();
    const walletId = randomUUID();
    const newer = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, streamVersion: 3, wallet: { balance: '30.00' }, payload: depositPayload('10.00') });
    const older = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, streamVersion: 2, wallet: { balance: '20.00' }, payload: depositPayload('10.00') });

    await ctx.publish('ledger', newer);
    await ctx.publish('ledger', older);
    await ctx.until(async () => ((await activities().countBy({ userId: ownerId })) === 2 ? true : undefined));

    expect(await walletOf(walletId)).toMatchObject({ balance: '30.00', streamVersion: 3 });
  });

  it('tracks a transfer through its saga and records its failure', async () => {
    const ownerId = randomUUID();
    const transferId = randomUUID();
    await ctx.publish('payments', paymentsEnvelope({ type: 'TransferInitiated', transferId, ownerId, streamVersion: 1 }));
    await ctx.publish('payments', paymentsEnvelope({ type: 'TransferStepChanged', transferId, ownerId, streamVersion: 3, payload: { status: 'funds_held' } }));
    await ctx.publish('payments', paymentsEnvelope({ type: 'TransferStepChanged', transferId, ownerId, streamVersion: 2, payload: { status: 'checked' } }));

    const held = await ctx.until(async () => {
      const t = await transfers().findOneBy({ transferId });
      return t?.streamVersion === 3 ? t : undefined;
    });
    expect(held.status).toBe('funds_held');

    await ctx.publish('payments', paymentsEnvelope({
      type: 'TransferFailed',
      transferId,
      ownerId,
      streamVersion: 5,
      payload: { status: 'failed', failureReason: 'recipient_blocked', fromCurrency: 'USD' },
    }));

    const failed = await ctx.until(async () => (await activities().findOneBy({ userId: ownerId, type: 'transfer_failed' })) ?? undefined);
    expect(failed.data).toMatchObject({ transferId, failureReason: 'recipient_blocked', amount: '10.00', currency: 'USD' });
    expect((await transfers().findOneByOrFail({ transferId })).status).toBe('failed');
  });

  it('dead-letters a malformed message and keeps consuming', async () => {
    const ownerId = randomUUID();
    const badId = await ctx.publish('ledger', '{"type":"MoneyDeposited"');
    const missingFields = ledgerEnvelope({ type: 'MoneyDeposited', ownerId, payload: { amount: '1.00' } });
    const missingId = await ctx.publish('ledger', missingFields);
    const good = ledgerEnvelope({ type: 'MoneyDeposited', ownerId, payload: depositPayload('1.00') });
    await ctx.publish('ledger', good);

    await ctx.until(async () => (await activities().findOneBy({ eventId: good.eventId })) ?? undefined);
    const dead = await ctx.until(async () => {
      const letters = await ctx.deadLetters();
      return letters.filter((l) => [badId, missingId].includes(l.id)).length === 2 ? letters : undefined;
    });

    expect(dead.find((l) => l.id === badId)).toMatchObject({ stream: ctx.streams.ledger, reason: 'envelope is not valid JSON' });
    expect(dead.find((l) => l.id === missingId)?.reason).toContain('payload.operationId');
    expect(JSON.parse(dead.find((l) => l.id === badId)?.fields as string).envelope).toBe('{"type":"MoneyDeposited"');
    await ctx.until(async () => ((await pendingCount(ctx.streams.ledger)) === 0 ? true : undefined));
    expect(await activities().countBy({ userId: ownerId })).toBe(1);
  });

  it('takes over messages left unacknowledged by a crashed consumer', async () => {
    await ctx.consumer.onModuleDestroy();
    const ownerId = randomUUID();
    const e = ledgerEnvelope({ type: 'MoneyDeposited', ownerId, payload: depositPayload('7.00') });
    await ctx.publish('ledger', e);
    await ctx.redis.xreadgroup('GROUP', 'notifications', 'crashed-consumer', 'COUNT', 100, 'STREAMS', ctx.streams.ledger, '>');
    expect(await pendingCount(ctx.streams.ledger)).toBeGreaterThan(0);

    const original = ctx.consumer.options.retryIdleMs;
    (ctx.consumer.options as { retryIdleMs: number }).retryIdleMs = 0;
    try {
      expect(await ctx.consumer.reclaimOnce()).toBeGreaterThan(0);
    } finally {
      (ctx.consumer.options as { retryIdleMs: number }).retryIdleMs = original;
    }

    expect(await activities().countBy({ eventId: e.eventId })).toBe(1);
    expect(await pendingCount(ctx.streams.ledger)).toBe(0);
  });

  it('dead-letters a message that keeps failing after the maximum number of deliveries', async () => {
    const e = ledgerEnvelope({ type: 'MoneyDeposited', wallet: { currency: 'EURO' }, payload: depositPayload('1.00') });
    const id = await ctx.publish('ledger', e);
    const options = ctx.consumer.options as { retryIdleMs: number };
    const original = options.retryIdleMs;
    options.retryIdleMs = 0;
    try {
      await ctx.consumer.pollOnce(50);
      expect(await pendingCount(ctx.streams.ledger)).toBe(1);
      await ctx.consumer.reclaimOnce();
      await ctx.consumer.reclaimOnce();
      expect(await ctx.deadLetters()).not.toContainEqual(expect.objectContaining({ id }));

      await ctx.consumer.reclaimOnce();
    } finally {
      options.retryIdleMs = original;
    }

    expect(await ctx.deadLetters()).toContainEqual(expect.objectContaining({ id, deliveries: '3' }));
    expect(await pendingCount(ctx.streams.ledger)).toBe(0);
    expect(await ctx.dataSource.getRepository(ProcessedEvent).countBy({ eventId: e.eventId })).toBe(0);
  });

  it('purges processed event ids past their retention', async () => {
    const repo = ctx.dataSource.getRepository(ProcessedEvent);
    const old = randomUUID();
    const recent = randomUUID();
    await repo.insert([
      { eventId: old, source: 'ledger', processedAt: new Date(Date.now() - 8 * 24 * 3_600_000) },
      { eventId: recent, source: 'ledger' },
    ]);

    const store = (ctx.consumer as unknown as { store: { purgeProcessed: (ms: number) => Promise<number> } }).store;
    expect(await store.purgeProcessed(7 * 24 * 3_600_000)).toBeGreaterThanOrEqual(1);

    expect(await repo.countBy({ eventId: old })).toBe(0);
    expect(await repo.countBy({ eventId: recent })).toBe(1);
  });
});

describe('Event consumer start-up (integration)', () => {
  it('processes events published before the service started', async () => {
    const ownerId = randomUUID();
    const walletId = randomUUID();
    const earlier = ledgerEnvelope({ type: 'MoneyDeposited', walletId, ownerId, payload: depositPayload('3.00'), wallet: { balance: '3.00' } });
    const ctx = await createNotificationsApp({}, {
      beforeStart: async ({ redis, streams }) => {
        await redis.xadd(streams.ledger, '*', 'eventId', earlier.eventId, 'type', earlier.type, 'envelope', JSON.stringify(earlier));
      },
    });
    try {
      const snapshot = await ctx.until(async () => (await ctx.dataSource.getRepository(WalletSnapshot).findOneBy({ walletId })) ?? undefined);
      expect(snapshot.balance).toBe('3.00');
    } finally {
      await ctx.close();
    }
  });
});
