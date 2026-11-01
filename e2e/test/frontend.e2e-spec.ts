import { randomUUID } from 'crypto';
import { FRONTEND_URL, LEDGER_URL, admin, call, openWallet, registerUser, subjectOf, until, walletIn } from '../src/client';

class Browser {
  private cookies = new Map<string, string>();

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${FRONTEND_URL}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        cookie: this.cookieHeader(),
        ...(init.headers ?? {}),
      },
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

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
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

    const page = await res.text();
    expect(res.status).toBe(200);
    expect(page).toContain('content="1;url=/dashboard"');
    expect(page).not.toContain('Reconciliation');
  });

  it('sends an admin whose token the services refuse to the login page', async () => {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const forged = `${part({ alg: 'HS256' })}.${part({ sub: randomUUID(), role: 'admin', exp: Date.now() / 1000 + 600 })}.bad`;

    const res = await fetch(`${FRONTEND_URL}/admin`, { redirect: 'manual', headers: { cookie: `accessToken=${forged}` } });
    const page = await res.text();

    expect(page).toContain('NEXT_REDIRECT');
    expect(page).toContain('/login');
    expect(page).not.toContain('Could not load the reconciliation report');
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

  it('revokes the session on sign-out and ignores sign-outs from other sites', async () => {
    const browser = await signUp(`logout-${randomUUID()}@example.com`);
    const stolen = browser.cookie('refreshToken');

    const forged = await browser.fetch('/api/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(forged.status).toBe(403);
    const opaque = await browser.fetch('/api/auth/logout', { method: 'POST', headers: { Origin: 'null' } });
    expect(opaque.status).toBe(403);

    const res = await browser.fetch('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(303);
    const refresh = await call('POST', `${LEDGER_URL}/auth/refresh`, { body: { refreshToken: stolen } });
    expect(refresh.status).toBe(401);
  });

  it('tops up once when the same Server Action form is submitted twice', async () => {
    const user = await registerUser('topup');
    const walletId = await openWallet(user, 'USD');
    const browser = new Browser();
    await browser.fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, password: 'password123' }),
    });
    const page = await (await browser.fetch('/wallets')).text();
    const form = [...page.matchAll(/<form[\s\S]*?<\/form>/g)].map(([html]) => html).find((html) => html.includes('name="formId"'));
    const fields = [...(form as string).matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map(([input]) => [
      /name="([^"]+)"/.exec(input)?.[1] as string,
      (/value="([^"]*)"/.exec(input)?.[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    ]);
    const submit = (amount: string) => {
      const body = new FormData();
      fields.forEach(([name, value]) => body.set(name, value));
      body.set('walletId', walletId);
      body.set('amount', amount);
      return browser.fetch('/wallets', { method: 'POST', body });
    };
    const balance = async () => (await call('GET', `${LEDGER_URL}/wallets/${walletId}`, { token: user.token })).body.balance;

    await submit('12.50');
    await submit('12.50');
    expect(await balance()).toBe('12.50');

    await submit('1.00');
    expect(await balance()).toBe('13.50');
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
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL ?? 'admin@ledger.local', password: process.env.ADMIN_PASSWORD ?? 'dev-only-admin-password' }),
    });
    expect(token).toBeTruthy();
    expect(login.status).toBe(200);

    const res = await browser.fetch('/admin');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Reconciliation');
  });
});
