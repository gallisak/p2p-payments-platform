import { randomUUID } from 'crypto';
import { BFF_URL, LEDGER_URL, NOTIFICATIONS_URL, PAYMENTS_URL, call, until } from '../src/client';

describe('Frontend API through the BFF (e2e)', () => {
  it('signs up, funds a wallet, sends a transfer and shows it all on one dashboard', async () => {
    const alice = `alice-${randomUUID()}@example.com`;
    const bob = `bob-${randomUUID()}@example.com`;
    const signup = async (email: string) => {
      const res = await call('POST', `${BFF_URL}/api/auth/register`, { body: { email, password: 'password123' } });
      expect(res.status).toBe(201);
      return res.body.accessToken as string;
    };
    const aliceToken = await signup(alice);
    await signup(bob);

    const wallet = await call('POST', `${BFF_URL}/api/wallets`, { token: aliceToken, body: { currency: 'USD' } });
    expect(wallet.status).toBe(201);
    expect((await call('POST', `${BFF_URL}/api/wallets/${wallet.body.id}/deposit`, { token: aliceToken, body: { amount: 70 } })).status).toBe(201);

    const key = randomUUID();
    const body = { fromWalletId: wallet.body.id, toWalletIdentifier: bob, amount: 20, currency: 'USD' };
    const created = await call('POST', `${BFF_URL}/api/transfers`, { token: aliceToken, body, headers: { 'Idempotency-Key': key } });
    expect(created.status).toBe(202);
    const replay = await call('POST', `${BFF_URL}/api/transfers`, { token: aliceToken, body, headers: { 'Idempotency-Key': key } });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(replay.body.id).toBe(created.body.id);

    const dashboard = await until(async () => {
      const res = await call('GET', `${BFF_URL}/api/dashboard`, { token: aliceToken });
      const done = res.body.transfers.data?.some((t: { id: string; status: string }) => t.id === created.body.id && t.status === 'completed');
      const fed = res.body.activity.data?.items.some((a: { type: string }) => a.type === 'transfer_sent');
      return done && fed ? res.body : undefined;
    }, 20_000, 'the dashboard to show the transfer');

    expect(dashboard.wallets).toEqual({
      status: 'ok',
      data: [expect.objectContaining({ id: wallet.body.id, currency: 'USD', balance: '50.00', held: '0.00' })],
    });
    expect(dashboard.activity.data.items.map((a: { type: string }) => a.type)).toEqual(['transfer_sent', 'deposit']);
    expect((await call('GET', `${BFF_URL}/api/dashboard`)).status).toBe(401);
  });

  it.each([
    ['ledger-service', LEDGER_URL, '/wallets'],
    ['payments-service', PAYMENTS_URL, '/transfers'],
    ['notifications-service', NOTIFICATIONS_URL, '/activity'],
    ['bff', BFF_URL, '/api/dashboard'],
  ])('serves the OpenAPI document of %s', async (_name, url, path) => {
    const res = await call('GET', `${url}/docs-json`);

    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths)).toContain(path);
  });

  it('documents the credentials each ledger route needs', async () => {
    const { paths } = (await call('GET', `${LEDGER_URL}/docs-json`)).body;

    expect(paths['/auth/login'].post.security).toBeUndefined();
    expect(paths['/wallets'].get.security).toEqual([{ bearer: [] }]);
    expect(paths['/internal/holds'].post.security).toEqual([{ 'internal-key': [] }]);
  });
});
