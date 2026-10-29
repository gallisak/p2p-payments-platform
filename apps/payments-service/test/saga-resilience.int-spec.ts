import { Transfer } from '../src/transfers/entities/transfer.entity';
import { SagaStep } from '../src/transfers/entities/saga-step.entity';
import { PaymentsApp, createPaymentsApp } from './support/integration-app';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Saga resilience (integration)', () => {
  describe('while the ledger is unavailable', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({
        SAGA_MAX_STEP_ATTEMPTS: '1000',
        SAGA_RETRY_MAX_MS: '100',
        LEDGER_BREAKER_FAILURES: '3',
        LEDGER_BREAKER_OPEN_MS: '300',
      });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('marks the transfer as awaiting a retry and finishes it once the ledger is back', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.down = true;

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 25, currency: 'USD' })
        .expect(202);
      const waiting = await ctx.waitFor(from.token, res.body.id, (t) => t.awaitingRetry === true);

      expect(waiting).toMatchObject({ status: 'pending', awaitingRetry: true });
      expect(waiting.lastError).toMatch(/503|circuit/);

      ctx.ledger.down = false;
      const done = await ctx.settle(from.token, res.body.id);
      expect(done).toMatchObject({ status: 'completed', awaitingRetry: false, lastError: null });
      expect(ctx.ledger.balances(to.walletId).balance).toBe('25.00');
    });

    it('stops calling the ledger while the circuit is open', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.down = true;

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);
      await sleep(1_000);
      const callsWhileDown = ctx.ledger.calls.length;

      expect(callsWhileDown).toBeGreaterThanOrEqual(3);
      expect(callsWhileDown).toBeLessThanOrEqual(10);
      const steps = await ctx.dataSource.getRepository(SagaStep).findBy({ transferId: res.body.id });
      expect(steps.length).toBeGreaterThan(callsWhileDown);
      expect(steps.some((s) => s.error?.includes('circuit is open'))).toBe(true);

      ctx.ledger.down = false;
      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ status: 'completed' });
    });

    it('treats dropped connections like an outage', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      let dropped = 0;
      ctx.ledger.intercept(async (call) => (call.op === 'place' && ++dropped <= 2 ? 'drop' : undefined));

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 10, currency: 'USD' })
        .expect(202);

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ status: 'completed' });
      expect(dropped).toBe(3);
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '90.00', held: '0.00' });
    });
  });

  describe('when retries run out', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ SAGA_MAX_STEP_ATTEMPTS: '3', LEDGER_BREAKER_FAILURES: '100' });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('fails a transfer that never reached the ledger', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.down = true;

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'ledger_unavailable' });
      expect(ctx.ledger.calls).toHaveLength(3);
    });

    it('retries instead of failing when the ledger refuses the internal API key', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.intercept(async () => 401);

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'ledger_unavailable' });
      expect(done.failureDetail).toContain('internal API key');
      expect(ctx.ledger.calls).toHaveLength(3);
    });

    it('voids a hold whose placement timed out so that the late placement reserves nothing', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const pending: (() => void)[] = [];
      ctx.ledger.intercept(async (call) => {
        if (call.op === 'place') {
          await new Promise<void>((resolve) => pending.push(resolve));
        }
      });

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 40, currency: 'USD' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);
      pending.forEach((resume) => resume());
      await sleep(100);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'ledger_unavailable' });
      expect(ctx.ledger.holds.get(res.body.id)?.status).toBe('voided');
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
    });
  });

  describe('stuck sagas', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ SAGA_TIMEOUT_MS: '1500', SAGA_MAX_STEP_ATTEMPTS: '1000' });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('compensates a saga that cannot finish before its deadline', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      ctx.ledger.intercept(async (call) => (call.op === 'capture' ? 503 : undefined));

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 20, currency: 'USD' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'timed_out' });
      expect(ctx.ledger.holds.get(res.body.id)?.status).toBe('released');
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
    });

    it('resumes a saga abandoned by a crashed worker once its lease expires', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      await ctx.worker.onModuleDestroy();
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 15, currency: 'USD' })
        .expect(202);
      await ctx.dataSource
        .getRepository(Transfer)
        .update({ id: res.body.id }, { nextAttemptAt: new Date(Date.now() + 800) });

      ctx.worker.onApplicationBootstrap();
      await sleep(250);
      expect((await ctx.dataSource.getRepository(Transfer).findOneByOrFail({ id: res.body.id })).status).toBe('pending');

      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ status: 'completed' });
    });

    it('applies the result of a step only once when two workers race on it', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      await ctx.worker.onModuleDestroy();
      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 15, currency: 'USD' })
        .expect(202);
      const repo = ctx.dataSource.getRepository(Transfer);
      const stale = await repo.findOneByOrFail({ id: res.body.id });

      await ctx.worker.runOnce();
      const steps = () => ctx.dataSource.getRepository(SagaStep).countBy({ transferId: res.body.id });
      expect(await steps()).toBe(1);

      const store = (ctx.worker as unknown as { store: { apply: (...args: unknown[]) => Promise<unknown> } }).store;
      const now = new Date();
      expect(
        await store.apply(stale, { kind: 'advance', status: 'checked', patch: {} }, { step: 'check', startedAt: now, finishedAt: now }),
      ).toBeNull();
      expect(await steps()).toBe(1);

      ctx.worker.onApplicationBootstrap();
      expect(await ctx.settle(from.token, res.body.id)).toMatchObject({ status: 'completed' });
    });

    it('lets several workers drain sagas without running a step twice', async () => {
      await ctx.worker.onModuleDestroy();
      const to = await ctx.account('USD');
      const senders = await Promise.all(Array.from({ length: 6 }, () => ctx.account('USD', '10')));
      const created = await Promise.all(
        senders.map((s) => ctx.transfer(s, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' }).expect(202)),
      );

      for (let i = 0; i < 8; i++) {
        await Promise.all([ctx.worker.runOnce(), ctx.worker.runOnce(), ctx.worker.runOnce()]);
      }

      const rows = await ctx.dataSource.getRepository(Transfer).findBy({});
      const ours = rows.filter((t) => created.some((c) => c.body.id === t.id));
      expect(ours.map((t) => t.status)).toEqual(Array(6).fill('completed'));
      for (const c of created) {
        const steps = await ctx.dataSource.getRepository(SagaStep).findBy({ transferId: c.body.id });
        expect(steps.map((s) => s.step).sort()).toEqual(['capture', 'check', 'confirm', 'hold']);
      }
      expect(ctx.ledger.balances(to.walletId).balance).toBe('6.00');
      ctx.worker.onApplicationBootstrap();
    });
  });

  describe('worker concurrency', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ SAGA_CONCURRENCY: '4', LEDGER_TIMEOUT_MS: '3000', SAGA_LEASE_MS: '15000' });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('keeps other sagas moving while one waits on a slow ledger call', async () => {
      const slow = await ctx.account('USD', '100');
      const fast = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      let release: () => void = () => undefined;
      const slowHold = new Promise<void>((resolve) => (release = resolve));
      ctx.ledger.intercept(async (call) => {
        if (call.op === 'place' && call.body.walletId === slow.walletId) await slowHold;
      });

      const a = await ctx.transfer(slow, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' }).expect(202);
      await ctx.waitFor(slow.token, a.body.id, (t) => t.status === 'checked');
      const b = await ctx.transfer(fast, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' }).expect(202);

      expect(await ctx.settle(fast.token, b.body.id, 2_000)).toMatchObject({ status: 'completed' });
      expect((await ctx.http().get(`/transfers/${a.body.id}`).set('Authorization', `Bearer ${slow.token}`)).body.status).toBe('checked');
      release();
      expect(await ctx.settle(slow.token, a.body.id)).toMatchObject({ status: 'completed' });
    });

    it('never runs more sagas at once than allowed', async () => {
      const to = await ctx.account('USD');
      const senders = await Promise.all(Array.from({ length: 8 }, () => ctx.account('USD', '10')));
      let concurrent = 0;
      let peak = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      ctx.ledger.intercept(async (call) => {
        if (call.op !== 'place') return;
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent -= 1;
      });

      const created = await Promise.all(
        senders.map((s) => ctx.transfer(s, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' }).expect(202)),
      );
      await sleep(600);
      expect(peak).toBe(4);
      release();
      const done = await Promise.all(created.map((r, i) => ctx.settle(senders[i].token, r.body.id)));

      expect(done.map((t) => t.status)).toEqual(Array(8).fill('completed'));
      expect(peak).toBe(4);
    });
  });

  describe('saga ordering', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ SAGA_CONCURRENCY: '1', SAGA_BATCH_SIZE: '1' });
    });

    afterAll(() => ctx.close());

    it('finishes older transfers first instead of advancing every saga one step at a time', async () => {
      await ctx.worker.onModuleDestroy();
      const to = await ctx.account('USD');
      const senders = await Promise.all(Array.from({ length: 5 }, () => ctx.account('USD', '10')));
      const created = [];
      for (const s of senders) {
        created.push(await ctx.transfer(s, { toWalletIdentifier: to.email, amount: 1, currency: 'USD' }).expect(202));
      }

      ctx.worker.onApplicationBootstrap();
      const done = await Promise.all(created.map((r, i) => ctx.settle(senders[i].token, r.body.id)));

      const finished = done.map((t) => Date.parse(t.completedAt as string));
      expect(finished).toEqual([...finished].sort((a, b) => a - b));
      const firstDone = finished[0];
      const lastStarted = Math.max(
        ...done.map((t) => Date.parse((t.steps as { step: string; startedAt: string }[]).find((s) => s.step === 'check')!.startedAt)),
      );
      expect(firstDone).toBeLessThan(lastStarted);
    });
  });

  describe('stale exchange rates', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ FX_QUOTE_TTL_MS: '150', FX_CACHE_TTL_MS: '0' });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('releases the hold when the rate expired before confirmation', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('EUR');
      ctx.ledger.responseDelayMs.place = 300;

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 10, currency: 'EUR' })
        .expect(202);
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'rate_expired' });
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId).balance).toBe('0.00');
    });
  });

  describe('exchange rates expiring while the ledger is down', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({
        FX_QUOTE_TTL_MS: '1500',
        FX_CACHE_TTL_MS: '0',
        SAGA_MAX_STEP_ATTEMPTS: '1000',
        LEDGER_BREAKER_FAILURES: '1000',
      });
    });

    afterEach(() => ctx.ledger.reset());
    afterAll(() => ctx.close());

    it('never captures at a rate that expired while the capture was being retried', async () => {
      const from = await ctx.account('USD', '100');
      const to = await ctx.account('EUR');
      let failCaptures = true;
      ctx.ledger.intercept(async (call) => (call.op === 'capture' && failCaptures ? 503 : undefined));

      const res = await ctx
        .transfer(from, { toWalletIdentifier: to.email, amount: 10, currency: 'EUR' })
        .expect(202);
      await ctx.waitFor(from.token, res.body.id, (t) => t.status === 'confirmed' && t.awaitingRetry === true);
      await sleep(1600);
      failCaptures = false;
      const done = await ctx.settle(from.token, res.body.id);

      expect(done).toMatchObject({ status: 'failed', failureReason: 'rate_expired' });
      expect(ctx.ledger.holds.get(res.body.id)?.status).toBe('released');
      expect(ctx.ledger.balances(from.walletId)).toEqual({ balance: '100.00', held: '0.00' });
      expect(ctx.ledger.balances(to.walletId).balance).toBe('0.00');
    });
  });

  describe('rate limiting', () => {
    let ctx: PaymentsApp;

    beforeAll(async () => {
      ctx = await createPaymentsApp({ TRANSFER_RATE_LIMIT_MAX: '3', TRANSFER_RATE_LIMIT_TTL_MS: '60000' });
    });

    afterAll(() => ctx.close());

    it('limits transfer creation per user', async () => {
      const a = await ctx.account('USD', '100');
      const b = await ctx.account('USD', '100');
      const to = await ctx.account('USD');
      const body = { toWalletIdentifier: to.email, amount: 1, currency: 'USD' };

      for (let i = 0; i < 3; i++) await ctx.transfer(a, body).expect(202);
      await ctx.transfer(a, body).expect(429);
      await ctx.transfer(b, body).expect(202);
      await ctx.http().get('/transfers').set('Authorization', `Bearer ${a.token}`).expect(200);
    });
  });
});
