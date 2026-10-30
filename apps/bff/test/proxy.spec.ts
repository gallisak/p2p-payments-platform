import { randomUUID } from 'crypto';
import { BffApp, createBffApp } from './support/bff-app';

const TOKEN = 'Bearer test-token';

describe('BFF proxy', () => {
  let ctx: BffApp;

  beforeAll(async () => {
    ctx = await createBffApp();
  });

  afterEach(() => ctx.reset());
  afterAll(() => ctx.close());

  describe('proxying', () => {
    it('relays the status and body of the upstream, including errors', async () => {
      ctx.ledger.on('POST', '/auth/login', { status: 201, body: { accessToken: 'a', refreshToken: 'r' } });
      ctx.payments.on('GET', '/split-bills', { status: 409, body: { message: 'conflict' } });

      await ctx.http().post('/api/auth/login').send({ email: 'a@example.com', password: 'p' }).expect(201, { accessToken: 'a', refreshToken: 'r' });
      await ctx.http().get('/api/split-bills').set('Authorization', TOKEN).expect(409, { message: 'conflict' });
    });

    it('forwards the Idempotency-Key and the replay marker of a transfer', async () => {
      const key = randomUUID();
      ctx.payments.on('POST', '/transfers', (r) => ({
        status: r.headers['idempotency-key'] === key ? 200 : 202,
        headers: { 'Idempotent-Replayed': 'true' },
        body: { id: 't1' },
      }));
      const body = { fromWalletId: randomUUID(), toWalletIdentifier: 'b@example.com', amount: 5, currency: 'USD' };

      const res = await ctx.http().post('/api/transfers').set('Authorization', TOKEN).set('Idempotency-Key', key).send(body).expect(200);

      expect(res.headers['idempotent-replayed']).toBe('true');
      expect(ctx.payments.received[0]).toMatchObject({ headers: { authorization: TOKEN, 'idempotency-key': key }, body });
    });

    it('does not invent an Idempotency-Key the client did not send', async () => {
      ctx.payments.on('POST', '/transfers', { status: 400, body: { message: 'Idempotency-Key required' } });

      await ctx
        .http()
        .post('/api/transfers')
        .set('Authorization', TOKEN)
        .send({ fromWalletId: randomUUID(), toWalletIdentifier: 'b@example.com', amount: 5, currency: 'USD' })
        .expect(400);

      expect(ctx.payments.received[0].headers['idempotency-key']).toBeUndefined();
    });

    it('validates input before calling any service', async () => {
      await ctx.http().post('/api/auth/login').send({ email: 'nope', password: 'p' }).expect(400);
      await ctx.http().post(`/api/wallets/not-a-uuid/deposit`).set('Authorization', TOKEN).send({ amount: 1 }).expect(400);
      await ctx.http().post(`/api/wallets/${randomUUID()}/deposit`).set('Authorization', TOKEN).send({ amount: -1 }).expect(400);
      await ctx.http().get('/api/admin/wallets/..%2F..%2Fauth/events').set('Authorization', TOKEN).expect(400);
      await ctx.http().post('/api/split-bills').set('Authorization', TOKEN).send({ title: 'x', participants: [] }).expect(400);

      expect([...ctx.ledger.received, ...ctx.payments.received]).toEqual([]);
    });

    it('passes on only the fields and query parameters it knows', async () => {
      const id = randomUUID();
      ctx.ledger.on('POST', `/wallets/${id}/deposit`, { status: 201, body: {} });
      ctx.notifications.on('GET', '/activity', { body: { items: [] } });

      await ctx.http().post(`/api/wallets/${id}/deposit`).set('Authorization', TOKEN).send({ amount: 5, ownerId: 'someone-else' }).expect(201);
      await ctx.http().get('/api/activity?type=deposit&limit=5&admin=true').set('Authorization', TOKEN).expect(200);

      expect(ctx.ledger.received[0].body).toEqual({ amount: 5 });
      expect(ctx.notifications.received[0].query).toEqual({ type: 'deposit', limit: '5' });
    });

    it('passes a sign-out on to the ledger', async () => {
      ctx.ledger.on('POST', '/auth/logout', { status: 204 });

      await ctx.http().post('/api/auth/logout').send({ refreshToken: 'r' }).expect(204);

      expect(ctx.ledger.received[0].body).toEqual({ refreshToken: 'r' });
    });

    it('reads a single wallet', async () => {
      const id = randomUUID();
      ctx.ledger.on('GET', `/wallets/${id}`, { body: { id, balance: '10.00' } });

      await ctx.http().get(`/api/wallets/${id}`).set('Authorization', TOKEN).expect(200, { id, balance: '10.00' });
    });

    it('tells a rate-limited client how long to wait', async () => {
      ctx.ledger.on('POST', '/auth/login', { status: 429, headers: { 'Retry-After': '42' }, body: { message: 'Too Many Requests' } });

      const res = await ctx.http().post('/api/auth/login').send({ email: 'a@example.com', password: 'p' }).expect(429);

      expect(res.headers['retry-after']).toBe('42');
    });

    it('gives long admin operations more time than ordinary calls', async () => {
      ctx.ledger.on('GET', '/admin/reconciliation', { delayMs: 500, body: { ok: true } });
      ctx.ledger.on('POST', '/admin/projections/rebuild', { delayMs: 500, status: 201, body: { rebuilt: 1 } });

      await ctx.http().get('/api/admin/reconciliation').set('Authorization', TOKEN).expect(200, { ok: true });
      await ctx.http().post('/api/admin/projections/rebuild').set('Authorization', TOKEN).expect(201, { rebuilt: 1 });
    });

    it('answers 503 when the service behind a route is unreachable', async () => {
      ctx.ledger.on('GET', '/wallets', { delayMs: 1_000, body: [] });

      const res = await ctx.http().get('/api/wallets').set('Authorization', TOKEN).expect(503);

      expect(res.body.message).toBe('ledger-service is temporarily unavailable, please try again later');
    });
  });

  describe('documentation', () => {
    it('publishes an OpenAPI document of every route', async () => {
      const res = await ctx.http().get('/docs-json').expect(200);

      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining([
          '/api/auth/login',
          '/api/wallets',
          '/api/transfers',
          '/api/split-bills/{id}/shares/{shareId}/pay',
          '/api/activity',
          '/api/admin/reconciliation',
        ]),
      );
    });
  });
});
