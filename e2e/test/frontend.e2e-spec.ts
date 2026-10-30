import { randomUUID } from 'crypto';
import { FRONTEND_URL, admin, openWallet, registerUser, subjectOf, until, walletIn } from '../src/client';

class Browser {
  private cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${FRONTEND_URL}${path}`, {
      redirect: 'manual',
      ...init,
      headers: { 'Content-Type': 'application/json', cookie: this.cookieHeader(), ...(init.headers ?? {}) },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return res;
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  drop(name: string): void {
    this.cookies.delete(name);
  }
}

async function signUp(email: string): Promise<Browser> {
  const browser = new Browser();
  const res = await browser.fetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password123' }),
  });
  expect(res.status).toBe(200);
  return browser;
}

describe('Frontend through the BFF (e2e)', () => {
  it('sends anonymous visitors to the login page', async () => {
    const res = await new Browser().fetch('/dashboard');

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect((await new Browser().fetch('/api/ws-token')).status).toBe(401);
  });

  it('renders every page of a signed-in user', async () => {
    const browser = await signUp(`pages-${randomUUID()}@example.com`);

    for (const path of ['/dashboard', '/wallets', '/transfers', '/activity', '/activity?type=deposit', '/split-bills']) {
      const res = await browser.fetch(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('P2P Ledger');
    }
  });

  it('keeps regular users out of the admin screen', async () => {
    const browser = await signUp(`user-${randomUUID()}@example.com`);

    const res = await browser.fetch('/admin');

    expect(await res.text()).not.toContain('Reconciliation');
  });

  it('renews an expired access token from the refresh cookie', async () => {
    const browser = await signUp(`renew-${randomUUID()}@example.com`);
    browser.drop('accessToken');

    const res = await browser.fetch('/api/ws-token');

    expect(res.status).toBe(200);
    expect(subjectOf((await res.json()).token)).toBeTruthy();
  });

  it('survives many requests renewing the same session at once', async () => {
    const browser = await signUp(`parallel-${randomUUID()}@example.com`);
    browser.drop('accessToken');

    const results = await Promise.all(Array.from({ length: 8 }, () => browser.fetch('/api/ws-token')));

    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
  });

  it('sends a transfer with its Idempotency-Key and replays it', async () => {
    const alice = await registerUser('alice');
    const bob = await registerUser('bob');
    const fromWalletId = await openWallet(alice, 'USD', 50);
    await openWallet(bob, 'USD');
    const browser = new Browser();
    const login = await browser.fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: alice.email, password: 'password123' }),
    });
    expect(login.status).toBe(200);
    const key = randomUUID();
    const send = () =>
      browser.fetch('/api/transfers', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ fromWalletId, toWalletIdentifier: bob.email, amount: 20, currency: 'USD' }),
      });

    const first = await send();
    const created = await first.json();
    expect(first.status).toBe(202);
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');

    await until(async () => {
      const res = await browser.fetch(`/api/transfers/${created.id}`);
      const body = await res.json();
      return body.status === 'completed' ? body : undefined;
    }, 20_000, 'the transfer to complete');
    expect((await walletIn(bob, 'USD'))?.balance).toBe('20.00');
  });

  it('shows the admin screen to the admin', async () => {
    const token = await admin();
    const browser = new Browser();
    const login = await browser.fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@ledger.local', password: process.env.ADMIN_PASSWORD ?? 'change-me-admin' }),
    });
    expect(token).toBeTruthy();
    expect(login.status).toBe(200);

    const res = await browser.fetch('/admin');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Reconciliation');
  });
});
