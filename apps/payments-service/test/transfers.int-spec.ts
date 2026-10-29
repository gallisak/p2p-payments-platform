import { randomUUID } from 'crypto';
import { Transfer } from '../src/transfers/entities/transfer.entity';
import { SagaStep } from '../src/transfers/entities/saga-step.entity';
import { PaymentsApp, createPaymentsApp } from './support/integration-app';

describe('Transfer saga on Postgres (integration)', () => {
  let ctx: PaymentsApp;

  beforeAll(async () => {
    ctx = await createPaymentsApp();
  });

  afterEach(() => {
    ctx.ledger.reset();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const transfers = () => ctx.dataSource.getRepository(Transfer);

  describe('happy path', () => {
    it('moves money through every step and reports them', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 40, currency: 'USD' })
        .expect(202);
      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body).toMatchObject({ status: 'pending', amount: '40.00', toCurrency: 'USD' });

      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({
        status: 'completed',
        fromCurrency: 'USD',
        toWalletId: to.walletId,
        creditAmount: '40.00',
        rate: '1.000000',
        failureReason: null,
        awaitingRetry: false,
      });
      expect((done.steps as { step: string; outcome: string }[]).map((s) => [s.step, s.outcome])).toEqual([
        ['check', 'succeeded'],
        ['hold', 'succeeded'],
        ['confirm', 'succeeded'],
        ['capture', 'succeeded'],
      ]);
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '60.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId)).toEqual({ balance: '40.00', held: '0.00' });
    });

    it('converts across currencies at the quoted rate', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('EUR');

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 50, currency: 'EUR' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'completed', rate: '0.920000', creditAmount: '46.00' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '50.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId)).toEqual({ balance: '46.00', held: '0.00' });
    });

    it('opens a wallet in the requested currency for the recipient', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 10, currency: 'UAH' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'completed', creditAmount: '415.00', toCurrency: 'UAH' });
      expect(done.toWalletId).not.toBe(to.walletId);
      expect(ctx.ledger.balances(done.toWalletId as string).balance).toBe('415.00');
    });

    it('publishes every state change through the outbox in order', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 5, currency: 'USD' })
        .expect(202);
      await ctx.settle(from.token, res.body.id);

      let events: Awaited<ReturnType<PaymentsApp['published']>> = [];
      for (let i = 0; i < 100; i++) {
        events = (await ctx.published()).filter((e) => e.envelope.streamId === res.body.id);
        if (events.some((e) => e.type === 'TransferCompleted')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      expect(events.map((e) => [e.type, e.envelope.payload.status])).toEqual([
        ['TransferInitiated', 'pending'],
        ['TransferStepChanged', 'checked'],
        ['TransferStepChanged', 'funds_held'],
        ['TransferStepChanged', 'confirmed'],
        ['TransferCompleted', 'completed'],
      ]);
      const versions = events.map((e) => e.envelope.streamVersion);
      expect(versions).toEqual([...versions].sort((a, b) => a - b));
      expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
      expect(events.at(-1)?.envelope).toMatchObject({
        ownerId: from.userId,
        recipientId: to.userId,
        schemaVersion: 1,
      });
    });
  });

  describe('validation and access', () => {
    it('requires a valid access token', async () => {
      await ctx.http().post('/transfers').set('Idempotency-Key', 'k1').send({}).expect(401);
      await ctx.http().get(`/transfers/${randomUUID()}`).set('Authorization', 'Bearer nope').expect(401);
    });

    it('requires an Idempotency-Key', async () => {
      const from = await ctx.account('USD', '10');
      const body = { fromWalletId: from.walletId, toWalletIdentifier: 'a@example.com', amount: 1, currency: 'USD' };

      await ctx.http().post('/transfers').set('Authorization', `Bearer ${from.token}`).send(body).expect(400);
      await ctx
        .http()
        .post('/transfers')
        .set('Authorization', `Bearer ${from.token}`)
        .set('Idempotency-Key', 'x'.repeat(256))
        .send(body)
        .expect(400);
      expect(await transfers().countBy({ senderId: from.userId })).toBe(0);
    });

    it.each([
      [{ amount: 0 }],
      [{ amount: 1.001 }],
      [{ amount: 1_000_001 }],
      [{ amount: '10' }],
      [{ currency: 'BTC' }],
      [{ toWalletIdentifier: 'not-an-email' }],
      [{ fromWalletId: 'wallet-1' }],
    ])('rejects an invalid request %j', async (override) => {
      const from = await ctx.account('USD', '10');
      await ctx
        .transfer(from, { toWalletIdentifier: 'a@example.com', amount: 1, currency: 'USD', ...override })
        .expect(400);
    });

    it('hides transfers of other users', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const stranger = await ctx.account('USD');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);

      await ctx.http().get(`/transfers/${res.body.id}`).set('Authorization', `Bearer ${stranger.token}`).expect(404);
      const list = await ctx.http().get('/transfers').set('Authorization', `Bearer ${stranger.token}`).expect(200);
      expect(list.body).toEqual([]);
      const own = await ctx.http().get('/transfers').set('Authorization', `Bearer ${from.token}`).expect(200);
      expect(own.body.map((t: { id: string }) => t.id)).toEqual([res.body.id]);
      await ctx.http().get('/transfers/not-a-uuid').set('Authorization', `Bearer ${from.token}`).expect(400);
    });

    it('shows only the latest saga steps of a long-running transfer', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);
      await ctx.settle(from.token, res.body.id);
      const started = new Date();
      await ctx.dataSource.getRepository(SagaStep).insert(
        Array.from({ length: 150 }, (_, i) => ({
          transferId: res.body.id,
          step: 'compensate',
          outcome: 'retry' as const,
          startedAt: started,
          durationMs: i,
          error: `attempt ${i}`,
        })),
      );

      const view = await ctx.http().get(`/transfers/${res.body.id}`).set('Authorization', `Bearer ${from.token}`).expect(200);

      expect(view.body.steps).toHaveLength(100);
      expect(view.body.steps[0].error).toBe('attempt 50');
      expect(view.body.steps.at(-1).error).toBe('attempt 149');
    });

    it('refuses to spend from a wallet of another user', async () => {
      const victim = await ctx.account('USD', '100');
      const thief = await ctx.account('USD');
      const res = await ctx
        .transfer({ ...thief, walletId: victim.walletId }, { toWalletIdentifier: thief.email, amount: 50, currency: 'USD' })
        .expect(202);

      const done = await ctx.settle(thief.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'source_wallet_not_found' });
      expect(ctx.ledger.callsOf('place').filter((c) => c.body.walletId === victim.walletId)).toEqual([]);
      expect(ctx.ledger.balances(victim.walletId)).toEqual({ balance: '100.00', held: '0.00' });
    });
  });

  describe('idempotency', () => {
    const body = (to: string) => ({ toWalletIdentifier: to, amount: 10, currency: 'USD' });

    it('returns the same transfer for a repeated key', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      const first = await ctx.transfer(from, body(to.email), key).expect(202);
      await ctx.settle(from.token, first.body.id);
      const again = await ctx.transfer(from, body(to.email), key).expect(200);

      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toMatchObject({ id: first.body.id, status: 'completed' });
      expect(ctx.ledger.balances(from.walletId).balance).toBe('90.00');
    });

    it('refuses a key reused for a different request', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      await ctx.transfer(from, body(to.email), key).expect(202);
      await ctx.transfer(from, { ...body(to.email), amount: 11 }, key).expect(422);
      await ctx.transfer(from, { ...body(to.email), currency: 'EUR' }, key).expect(422);
    });

    it('treats the same amount written differently as the same request', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      const first = await ctx.transfer(from, { ...body(to.email), amount: 10 }, key).expect(202);
      const again = await ctx.transfer(from, { ...body(to.email), amount: 10.0 }, key).expect(200);
      expect(again.body.id).toBe(first.body.id);
    });

    it('treats the recipient email in another letter case as the same request', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      const first = await ctx.transfer(from, body(to.email.toUpperCase()), key).expect(202);
      const again = await ctx.transfer(from, body(to.email), key).expect(200);

      expect(again.body.id).toBe(first.body.id);
      expect(first.body.recipientEmail).toBe(to.email);
      expect(await ctx.settle(from.token, first.body.id)).toMatchObject({ status: 'completed' });
    });

    it('creates exactly one transfer for concurrent duplicates', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => ctx.transfer(from, body(to.email), key)),
      );

      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 200)).toHaveLength(19);
      await ctx.settle(from.token, [...ids][0]);
      expect(await transfers().countBy({ senderId: from.userId })).toBe(1);
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '90.00', held: '0.00' });
    });

    it('scopes keys to the sender', async () => {
      const a = await ctx.account('USD', '100');
      const b = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const key = randomUUID();

      const first = await ctx.transfer(a, body(to.email), key).expect(202);
      const second = await ctx.transfer(b, body(to.email), key).expect(202);
      expect(second.body.id).not.toBe(first.body.id);
    });
  });

  describe('business failures', () => {
    it('fails on insufficient funds without holding anything', async () => {
      const from = await ctx.account('USD', '10');
      const to = await ctx.account('USD');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 10.01, currency: 'USD' })
        .expect(202);

      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '10.00', held: '0.00' });
    });

    it.each([
      ['an unknown recipient', () => 'nobody@example.com', 'recipient_not_found'],
      ['a recipient on the deny list', () => 'banned@example.com', 'recipient_not_allowed'],
    ])('fails for %s', async (_name, recipient, reason) => {
      const from = await ctx.account('USD', '10');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: recipient(), amount: 1, currency: 'USD' })
        .expect(202);

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ status: 'failed', failureReason: reason });
    });

    it('fails a transfer to the same wallet', async () => {
      const from = await ctx.account('USD', '10');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: from.email, amount: 1, currency: 'USD' })
        .expect(202);

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ failureReason: 'same_wallet' });
    });

    it('fails a transfer above the per-transfer limit', async () => {
      const from = await ctx.account('UAH', '1000000');
      const to = await ctx.account('USD');
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 415_100, currency: 'USD' })
        .expect(202);

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ failureReason: 'limit_exceeded' });
      expect(ctx.ledger.callsOf('place').filter((c) => c.body.holdId === res.body.id)).toEqual([]);
    });

    it('enforces the daily limit even for concurrent transfers', async () => {
      const from = await ctx.account('USD', '100000');
      const to = await ctx.account('USD');

      const created = await Promise.all(
        Array.from({ length: 8 }, () =>
          ctx.transfer(from, { toWalletIdentifier: to.email, amount: 9_000, currency: 'USD' }).expect(202),
        ),
      );
      const results = await Promise.all(created.map((r) => ctx.settle(from.token, r.body.id)));

      expect(results.filter((t) => t.status === 'completed')).toHaveLength(5);
      expect(results.filter((t) => t.failureReason === 'daily_limit_exceeded')).toHaveLength(3);
      expect(ctx.ledger.balances(to.walletId).balance).toBe('45000.00');
    });

    it('fails when the sender wallet is blocked', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.wallets.get(from.walletId)!.blocked = true;
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ failureReason: 'source_wallet_blocked' });
    });
  });

  describe('compensation', () => {
    it('releases the hold when the recipient is blocked after the funds were reserved', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.intercept(async (call) => {
        if (call.op === 'place') ctx.ledger.wallets.get(to.walletId)!.blocked = true;
      });
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 30, currency: 'USD' })
        .expect(202);

      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'recipient_blocked' });
      expect((done.steps as { step: string; outcome: string }[]).map((s) => [s.step, s.outcome])).toEqual([
        ['check', 'succeeded'],
        ['hold', 'succeeded'],
        ['confirm', 'failed'],
        ['compensate', 'succeeded'],
      ]);
      expect(ctx.ledger.holds.get(res.body.id)?.status).toBe('released');
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId)).toEqual({ balance: '0.00', held: '0.00' });
    });

    it('releases the hold when the ledger refuses the capture', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.intercept(async (call) => {
        if (call.op === 'capture') ctx.ledger.wallets.get(to.walletId)!.blocked = true;
      });
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 30, currency: 'USD' })
        .expect(202);

      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'wallet_blocked' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
    });

    it('completes instead of failing when a timed-out capture actually went through', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.responseDelayMs.capture = 800;
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 30, currency: 'USD' })
        .expect(202);

      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'completed', failureReason: null });
      const steps = done.steps as { step: string; outcome: string }[];
      expect(steps.filter((s) => s.step === 'capture').map((s) => s.outcome)).toContain('retry');
      expect(steps.at(-1)).toMatchObject({ step: 'compensate', outcome: 'succeeded' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '70.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId).balance).toBe('30.00');
    });

    it('keeps retrying compensation until the ledger accepts the release', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      let releases = 0;
      ctx.ledger.intercept(async (call) => {
        if (call.op === 'place') ctx.ledger.wallets.get(to.walletId)!.blocked = true;
        if (call.op === 'release' && ++releases <= 8) return 503;
      });
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 30, currency: 'USD' })
        .expect(202);

      const compensating = await ctx.waitFor(from.token, res.body.id, (t) => t.status === 'compensating' && t.awaitingRetry === true);
      expect(compensating.lastError).toContain('503');
      const done = await ctx.settle(from.token, res.body.id);

      expect(releases).toBeGreaterThan(8);
      expect(done).toMatchObject({ status: 'failed', failureReason: 'recipient_blocked' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
    });
  });
});
