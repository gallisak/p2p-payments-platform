import { randomUUID } from 'crypto';
import { BFF_URL, LEDGER_URL, NOTIFICATIONS_URL, PAYMENTS_URL, call, openWallet, registerUser, until } from '../src/client';

describe('Idempotent money movements through the BFF (e2e)', () => {
  it('applies a repeated deposit and withdrawal once', async () => {
    const user = await registerUser('idem');
    const walletId = await openWallet(user, 'USD');
    const send = (action: string, key: string, amount: number) =>
      call('POST', `${BFF_URL}/api/wallets/${walletId}/${action}`, {
        token: user.token,
        headers: { 'Idempotency-Key': key },
        body: { amount },
      });
    const [depositKey, withdrawKey] = [randomUUID(), randomUUID()];

    expect((await send('deposit', depositKey, 50)).status).toBe(201);
    const replay = await send('deposit', depositKey, 50);
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect((await send('withdraw', withdrawKey, 20)).status).toBe(201);
    expect((await send('withdraw', withdrawKey, 20)).status).toBe(200);

    const wallet = await call('GET', `${BFF_URL}/api/wallets/${walletId}`, { token: user.token });
    expect(wallet.body.balance).toBe('30.00');
  });

  it('creates a split bill once for a repeated request', async () => {
    const creator = await registerUser('creator');
    const guest = await registerUser('guest');
    await openWallet(guest, 'USD');
    const key = randomUUID();
    const body = {
      title: 'Dinner',
      currency: 'USD',
      totalAmount: 30,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      split: 'equal',
      participants: [{ email: guest.email }],
    };
    const send = () =>
      call('POST', `${BFF_URL}/api/split-bills`, { token: creator.token, headers: { 'Idempotency-Key': key }, body });

    const first = await send();
    const again = await send();

    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
  });
});

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
