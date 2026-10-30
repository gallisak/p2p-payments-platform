import { randomUUID } from 'crypto';
import { SplitShare } from '../src/split-bills/entities/split-share.entity';
import { SplitBill } from '../src/split-bills/entities/split-bill.entity';
import { SplitRemindersWorker } from '../src/split-bills/split-reminders.worker';
import { Account, PaymentsApp, createPaymentsApp } from './support/integration-app';

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('Split bills on Postgres (integration)', () => {
  let ctx: PaymentsApp;

  beforeAll(async () => {
    ctx = await createPaymentsApp({ SPLIT_REMINDER_INTERVAL_MS: '0', SPLIT_REMINDER_MAX: '2' });
  });

  afterEach(() => ctx.ledger.reset());
  afterAll(() => ctx.close());

  const authed = (user: Account) => ({
    post: (path: string, body: object, key?: string) => {
      const req = ctx.http().post(path).set('Authorization', `Bearer ${user.token}`);
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    },
    get: (path: string) => ctx.http().get(path).set('Authorization', `Bearer ${user.token}`),
  });

  async function bill(creator: Account, participants: Account[], overrides: object = {}) {
    const res = await authed(creator)
      .post('/split-bills', {
        title: 'Dinner',
        currency: 'USD',
        totalAmount: 90,
        dueAt: inDays(7),
        split: 'equal',
        participants: participants.map((p) => ({ email: p.email })),
        ...overrides,
      })
      .expect(201);
    return res.body;
  }

  const shareOf = (b: { shares: { id: string; participantId: string; amount: string }[] }, user: Account) =>
    b.shares.find((s) => s.participantId === user.userId) as { id: string; amount: string };

  const pay = (b: { id: string }, shareId: string, user: Account, key = randomUUID(), wallet = user.walletId) =>
    authed(user).post(`/split-bills/${b.id}/shares/${shareId}/pay`, { fromWalletId: wallet }, key);

  describe('creating a bill', () => {
    it('splits equally, including the creator, down to the cent', async () => {
      const creator = await ctx.account('USD');
      const [a, b] = await Promise.all([ctx.account('USD'), ctx.account('USD')]);

      const created = await bill(creator, [a, b], { totalAmount: 100, includeCreator: true });

      expect(created).toMatchObject({
        title: 'Dinner',
        creatorId: creator.userId,
        currency: 'USD',
        totalAmount: '100.00',
        creatorAmount: '33.33',
        split: 'equal',
        status: 'pending',
      });
      expect(created.shares.map((s: { amount: string }) => s.amount).sort()).toEqual(['33.33', '33.34']);
      expect(created.shares.every((s: { status: string }) => s.status === 'pending')).toBe(true);
    });

    it('accepts custom shares that add up to the total', async () => {
      const creator = await ctx.account('USD');
      const [a, b] = await Promise.all([ctx.account('USD'), ctx.account('USD')]);

      const created = await bill(creator, [a, b], {
        split: 'custom',
        participants: [{ email: a.email.toUpperCase(), amount: 60 }, { email: b.email, amount: 30 }],
      });

      expect(shareOf(created, a).amount).toBe('60.00');
      expect(shareOf(created, b).amount).toBe('30.00');
      expect(created.creatorAmount).toBe('0.00');
    });

    it.each([
      ['a participant listed twice', (p: Account[]) => ({ participants: [{ email: p[0].email }, { email: p[0].email.toUpperCase() }] })],
      ['the creator as a participant', (_p: Account[], c: Account) => ({ participants: [{ email: c.email }] })],
      ['an unknown participant', () => ({ participants: [{ email: 'nobody@example.com' }] })],
      ['custom shares that do not add up', (p: Account[]) => ({ split: 'custom', participants: [{ email: p[0].email, amount: 10 }] })],
      ['custom shares without amounts', (p: Account[]) => ({ split: 'custom', participants: [{ email: p[0].email }] })],
      ['amounts on an equal split', (p: Account[]) => ({ participants: [{ email: p[0].email, amount: 90 }] })],
      ['includeCreator on a custom split', (p: Account[]) => ({ split: 'custom', includeCreator: true, participants: [{ email: p[0].email, amount: 90 }] })],
      ['a due date in the past', () => ({ dueAt: inDays(-1) })],
      ['a due date more than a year away', () => ({ dueAt: inDays(400) })],
      ['an unsupported currency', () => ({ currency: 'BTC' })],
      ['no participants', () => ({ participants: [] })],
      ['a blank title', () => ({ title: '   ' })],
      ['a share above the per-transfer limit', () => ({ totalAmount: 10_000.01 })],
      ['a share above the per-transfer limit after conversion', () => ({ currency: 'UAH', totalAmount: 415_100 })],
      ['too many participants', () => ({ participants: Array.from({ length: 51 }, (_, i) => ({ email: `p${i}@example.com` })) })],
      ['a total too small to split', (p: Account[]) => ({ totalAmount: 0.01, includeCreator: true, participants: [{ email: p[0].email }] })],
    ])('refuses %s', async (_name, override) => {
      const creator = await ctx.account('USD');
      const participant = await ctx.account('USD');
      const body = {
        title: 'Bill',
        currency: 'USD',
        totalAmount: 90,
        dueAt: inDays(7),
        split: 'equal',
        participants: [{ email: participant.email }],
        ...override([participant], creator),
      };

      await authed(creator).post('/split-bills', body).expect(400);
      expect(await ctx.dataSource.getRepository(SplitBill).countBy({ creatorId: creator.userId })).toBe(0);
    });

    it('requires authentication', async () => {
      await ctx.http().post('/split-bills').send({}).expect(401);
      await ctx.http().get('/split-bills').expect(401);
    });
  });

  describe('visibility', () => {
    it('shows a bill to its creator and participants only', async () => {
      const creator = await ctx.account('USD');
      const participant = await ctx.account('USD');
      const stranger = await ctx.account('USD');
      const created = await bill(creator, [participant]);

      await authed(creator).get(`/split-bills/${created.id}`).expect(200);
      await authed(participant).get(`/split-bills/${created.id}`).expect(200);
      await authed(stranger).get(`/split-bills/${created.id}`).expect(404);
      await authed(stranger).get(`/split-bills/${randomUUID()}`).expect(404);

      expect((await authed(creator).get('/split-bills').expect(200)).body.map((b: { id: string }) => b.id)).toEqual([created.id]);
      expect((await authed(participant).get('/split-bills').expect(200)).body.map((b: { id: string }) => b.id)).toEqual([created.id]);
      expect((await authed(stranger).get('/split-bills').expect(200)).body).toEqual([]);
    });
  });

  describe('paying shares', () => {
    it('moves the bill from pending through partially paid to settled', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '100');
      const b = await ctx.account('USD', '100');
      const created = await bill(creator, [a, b]);

      const first = await pay(created, shareOf(created, a).id, a).expect(202);
      expect(first.body).toMatchObject({ toCurrency: 'USD', amount: '45.00', splitShareId: shareOf(created, a).id });
      expect((await authed(a).get(`/split-bills/${created.id}`)).body.shares.find((s: { id: string }) => s.id === shareOf(created, a).id).status).toBe('paying');
      await ctx.settle(a.token, first.body.id);
      const partial = (await authed(creator).get(`/split-bills/${created.id}`)).body;
      expect(partial.status).toBe('partially_paid');
      expect(shareOf(partial, a)).toMatchObject({ status: 'paid', transferId: first.body.id });

      const second = await pay(created, shareOf(created, b).id, b).expect(202);
      await ctx.settle(b.token, second.body.id);
      const settled = (await authed(creator).get(`/split-bills/${created.id}`)).body;

      expect(settled.status).toBe('settled');
      expect(settled.settledAt).not.toBeNull();
      expect(ctx.ledger.balances(creator.walletId).balance).toBe('90.00');
      expect(ctx.ledger.balances(a.walletId).balance).toBe('55.00');

      const types = await until(async () => {
        const events = (await ctx.published()).filter((e) => e.envelope.streamId === created.id).map((e) => e.type);
        return events.includes('SplitBillSettled') ? events : undefined;
      });
      expect(types).toEqual(['SplitBillCreated', 'SplitSharePaid', 'SplitSharePaid', 'SplitBillSettled']);
    });

    it('returns a share to pending when its transfer fails, so it can be paid again', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '10');
      const created = await bill(creator, [a], { totalAmount: 40 });

      const failed = await pay(created, shareOf(created, a).id, a).expect(202);
      expect(await ctx.settle(a.token, failed.body.id)).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
      const after = (await authed(a).get(`/split-bills/${created.id}`)).body;
      expect(shareOf(after, a)).toMatchObject({ status: 'pending', transferId: null });
      expect(after.status).toBe('pending');

      ctx.ledger.wallets.get(a.walletId)!.balance += 10_000n;
      const retry = await pay(created, shareOf(created, a).id, a).expect(202);
      await ctx.settle(a.token, retry.body.id);
      expect((await authed(creator).get(`/split-bills/${created.id}`)).body.status).toBe('settled');
    });

    it('pays a share exactly once however the request is repeated', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '100');
      const created = await bill(creator, [a], { totalAmount: 20 });
      const shareId = shareOf(created, a).id;
      const repeated = randomUUID();
      const keys = [...Array(5).fill(repeated), ...Array.from({ length: 5 }, () => randomUUID())];

      const responses = await Promise.all(keys.map((key) => pay(created, shareId, a, key)));
      const accepted = responses.filter((r) => r.status === 202);
      expect(accepted).toHaveLength(1);
      const winningKey = keys[responses.indexOf(accepted[0])];
      expect(responses.filter((r) => ![200, 202, 409].includes(r.status))).toEqual([]);
      const transferId = accepted[0].body.id;
      await ctx.settle(a.token, transferId);

      const replay = await pay(created, shareId, a, winningKey);
      const another = await pay(created, shareId, a);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(transferId);
      expect(another.status).toBe(409);
      expect(ctx.ledger.balances(a.walletId).balance).toBe('80.00');
      expect([...ctx.ledger.holds.values()].filter((h) => h.walletId === a.walletId)).toHaveLength(1);
    });

    it('replays a repeated payment request without asking the ledger again', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '100');
      const created = await bill(creator, [a], { totalAmount: 20 });
      const key = randomUUID();
      const first = await pay(created, shareOf(created, a).id, a, key).expect(202);
      await ctx.settle(a.token, first.body.id);

      ctx.ledger.down = true;
      const replay = await pay(created, shareOf(created, a).id, a, key).expect(200);
      await pay(created, shareOf(created, a).id, a).expect(503);

      expect(replay.body).toMatchObject({ id: first.body.id, status: 'completed' });
    });

    it('lets only the participant pay their own share', async () => {
      const creator = await ctx.account('USD', '100');
      const a = await ctx.account('USD', '100');
      const b = await ctx.account('USD', '100');
      const stranger = await ctx.account('USD', '100');
      const created = await bill(creator, [a, b]);

      await pay(created, shareOf(created, a).id, b).expect(404);
      await pay(created, shareOf(created, a).id, stranger).expect(404);
      await pay(created, shareOf(created, a).id, creator).expect(404);
      await pay(created, shareOf(created, a).id, a, randomUUID(), b.walletId).expect(400);
      expect(ctx.ledger.callsOf('place')).toEqual([]);
    });

    it('accepts payment only from a wallet in the bill currency', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('EUR', '100');
      const created = await bill(creator, [a]);

      const res = await pay(created, shareOf(created, a).id, a).expect(400);
      expect(res.body.message).toContain('USD');
    });

    it('validates the payment request', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '100');
      const created = await bill(creator, [a]);
      const path = `/split-bills/${created.id}/shares/${shareOf(created, a).id}/pay`;

      await authed(a).post(path, { fromWalletId: a.walletId }).expect(400);
      await authed(a).post(path, { fromWalletId: 'nope' }, randomUUID()).expect(400);
      await authed(a).post(`/split-bills/${created.id}/shares/not-a-uuid/pay`, { fromWalletId: a.walletId }, randomUUID()).expect(400);
    });
  });

  describe('overdue reminders', () => {
    const reminders = () => ctx.app.get(SplitRemindersWorker);
    const overdueEvents = async (billId: string) =>
      (await ctx.published()).filter((e) => e.envelope.streamId === billId && e.type === 'SplitShareOverdue');

    it('reminds only unpaid participants once the bill is overdue, up to the configured limit', async () => {
      const creator = await ctx.account('USD');
      const payer = await ctx.account('USD', '100');
      const late = await ctx.account('USD');
      const created = await bill(creator, [payer, late]);
      const paid = await pay(created, shareOf(created, payer).id, payer).expect(202);
      await ctx.settle(payer.token, paid.body.id);

      expect(await reminders().runOnce()).toBe(0);
      await ctx.dataSource.getRepository(SplitBill).update({ id: created.id }, { dueAt: new Date(Date.now() - 1_000) });

      expect(await reminders().runOnce()).toBe(1);
      expect(await reminders().runOnce()).toBe(1);
      expect(await reminders().runOnce()).toBe(0);

      const share = await ctx.dataSource.getRepository(SplitShare).findOneByOrFail({ id: shareOf(created, late).id });
      expect(share.reminderCount).toBe(2);
      const events = await until(async () => {
        const found = await overdueEvents(created.id);
        return found.length === 2 ? found : undefined;
      });
      expect(events.map((e) => (e.envelope.payload.share as { participantId: string }).participantId)).toEqual([late.userId, late.userId]);
      expect(events[0].envelope.payload.bill).toMatchObject({ id: created.id, title: 'Dinner', status: 'partially_paid' });
    });

    it('does not remind a participant whose payment is in progress', async () => {
      const creator = await ctx.account('USD');
      const a = await ctx.account('USD', '100');
      const created = await bill(creator, [a]);
      await ctx.worker.onModuleDestroy();
      try {
        await pay(created, shareOf(created, a).id, a).expect(202);
        await ctx.dataSource.getRepository(SplitBill).update({ id: created.id }, { dueAt: new Date(Date.now() - 1_000) });

        expect(await reminders().runOnce()).toBe(0);
      } finally {
        ctx.worker.onApplicationBootstrap();
      }
    });
  });
});
