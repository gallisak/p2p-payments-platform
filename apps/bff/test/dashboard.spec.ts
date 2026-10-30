import { BffApp, createBffApp } from './support/bff-app';

const TOKEN = 'Bearer test-token';

describe('BFF dashboard', () => {
  let ctx: BffApp;

  beforeAll(async () => {
    ctx = await createBffApp();
  });

  afterEach(() => ctx.reset());
  afterAll(() => ctx.close());

  describe('dashboard', () => {
    const allUp = () => {
      ctx.ledger.on('GET', '/wallets', { body: [{ id: 'w1', balance: '10.00' }] });
      ctx.payments.on('GET', '/transfers', { body: [{ id: 't1', status: 'completed' }] });
      ctx.notifications.on('GET', '/activity', { body: { items: [{ type: 'deposit' }], nextCursor: null } });
    };

    it('aggregates wallets, transfers and activity in one response', async () => {
      allUp();

      const res = await ctx.http().get('/api/dashboard').set('Authorization', TOKEN).expect(200);

      expect(res.body).toEqual({
        wallets: { status: 'ok', data: [{ id: 'w1', balance: '10.00' }] },
        transfers: { status: 'ok', data: [{ id: 't1', status: 'completed' }] },
        activity: { status: 'ok', data: { items: [{ type: 'deposit' }], nextCursor: null } },
      });
      for (const upstream of [ctx.ledger, ctx.payments, ctx.notifications]) {
        expect(upstream.received[0].headers.authorization).toBe(TOKEN);
      }
      expect(ctx.payments.received[0].query).toEqual({ limit: '10' });
      expect(ctx.notifications.received[0].query).toEqual({ limit: '20' });
    });

    it.each([
      ['an error', { status: 500, body: { message: 'boom' } }],
      ['a timeout', { delayMs: 2_000, body: [] }],
      ['a bad gateway', { status: 502 }],
    ])('degrades a section whose service answers with %s', async (_name, reply) => {
      allUp();
      ctx.payments.on('GET', '/transfers', reply);

      const started = Date.now();
      const res = await ctx.http().get('/api/dashboard').set('Authorization', TOKEN).expect(200);

      expect(Date.now() - started).toBeLessThan(1_500);
      expect(res.body.transfers).toEqual({ status: 'unavailable', error: 'Transfers are temporarily unavailable' });
      expect(res.body.wallets.status).toBe('ok');
      expect(res.body.activity.status).toBe('ok');
    });

    it('still answers when every service is down', async () => {
      ctx.ledger.on('GET', '/wallets', { status: 503 });
      ctx.payments.on('GET', '/transfers', { status: 503 });
      ctx.notifications.on('GET', '/activity', { status: 503 });

      const res = await ctx.http().get('/api/dashboard').set('Authorization', TOKEN).expect(200);

      expect(Object.values(res.body).map((s) => (s as { status: string }).status)).toEqual([
        'unavailable',
        'unavailable',
        'unavailable',
      ]);
    });

    it('rejects an invalid session instead of showing empty sections', async () => {
      allUp();
      ctx.ledger.on('GET', '/wallets', { status: 401, body: { message: 'Unauthorized' } });

      await ctx.http().get('/api/dashboard').set('Authorization', TOKEN).expect(401);
    });

    it('is part of the OpenAPI document', async () => {
      const res = await ctx.http().get('/docs-json').expect(200);

      expect(Object.keys(res.body.paths)).toContain('/api/dashboard');
    });

    it('requires a token before calling anything', async () => {
      await ctx.http().get('/api/dashboard').expect(401);
      expect([...ctx.ledger.received, ...ctx.payments.received, ...ctx.notifications.received]).toEqual([]);
    });
  });
});
