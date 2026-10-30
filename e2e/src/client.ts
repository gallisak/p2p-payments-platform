import { randomUUID } from 'crypto';
import { Socket, io } from 'socket.io-client';

export const LEDGER_URL = process.env.LEDGER_URL ?? 'http://localhost:3001';
export const PAYMENTS_URL = process.env.PAYMENTS_URL ?? 'http://localhost:3002';
export const NOTIFICATIONS_URL = process.env.NOTIFICATIONS_URL ?? 'http://localhost:3003';
export const BFF_URL = process.env.BFF_URL ?? 'http://localhost:3004';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@ledger.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-me-admin';

export interface Response<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(
  method: 'GET' | 'POST',
  url: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response<T>> {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

function expectStatus<T>(res: Response<T>, ...expected: number[]): Response<T> {
  if (!expected.includes(res.status)) {
    throw new Error(`Expected HTTP ${expected.join('/')}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
}

export interface User {
  email: string;
  token: string;
  userId: string;
}

export function subjectOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
}

export async function registerUser(prefix = 'user'): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  const res = expectStatus(
    await call('POST', `${LEDGER_URL}/auth/register`, { body: { email, password: 'password123' } }),
    201,
  );
  return { email, token: res.body.accessToken, userId: subjectOf(res.body.accessToken) };
}

let adminToken: Promise<string> | undefined;

export function admin(): Promise<string> {
  adminToken ??= call('POST', `${LEDGER_URL}/auth/login`, {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  }).then((res) => expectStatus(res, 201).body.accessToken as string);
  return adminToken;
}

export interface Wallet {
  id: string;
  currency: string;
  balance: string;
  held: string;
  blocked: boolean;
}

export async function openWallet(user: User, currency: string, deposit?: number): Promise<string> {
  const res = expectStatus(await call('POST', `${LEDGER_URL}/wallets`, { token: user.token, body: { currency } }), 201);
  if (deposit) {
    expectStatus(
      await call('POST', `${LEDGER_URL}/wallets/${res.body.id}/deposit`, { token: user.token, body: { amount: deposit } }),
      201,
    );
  }
  return res.body.id;
}

export async function wallets(user: User): Promise<Wallet[]> {
  return expectStatus(await call<Wallet[]>('GET', `${LEDGER_URL}/wallets`, { token: user.token }), 200).body;
}

export async function walletIn(user: User, currency: string): Promise<Wallet | undefined> {
  return (await wallets(user)).find((w) => w.currency === currency);
}

export function createTransfer(
  user: User,
  body: { fromWalletId: string; toWalletIdentifier: string; amount: number; currency: string },
  key: string = randomUUID(),
) {
  return call('POST', `${PAYMENTS_URL}/transfers`, {
    token: user.token,
    body,
    headers: { 'Idempotency-Key': key },
  });
}

export async function transfer(user: User, id: string) {
  return expectStatus(await call('GET', `${PAYMENTS_URL}/transfers/${id}`, { token: user.token }), 200).body;
}

export async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}${lastError ? `: ${(lastError as Error).message}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function settled(user: User, id: string, timeoutMs = 30_000) {
  return until(
    async () => {
      const t = await transfer(user, id);
      return t.status === 'completed' || t.status === 'failed' ? t : undefined;
    },
    timeoutMs,
    `transfer ${id} to settle`,
  );
}

export async function eventsOf(walletId: string) {
  return expectStatus(await call('GET', `${LEDGER_URL}/admin/wallets/${walletId}/events`, { token: await admin() }), 200)
    .body as { type: string; payload: Record<string, any>; streamVersion: number }[];
}

export async function reconciliation() {
  return expectStatus(await call('GET', `${LEDGER_URL}/admin/reconciliation`, { token: await admin() }), 200).body;
}

export async function blockWallet(walletId: string, reason = 'e2e') {
  expectStatus(
    await call('POST', `${LEDGER_URL}/admin/wallets/${walletId}/block`, { token: await admin(), body: { reason } }),
    201,
  );
}

export async function activity(user: User, query = '') {
  return expectStatus(await call('GET', `${NOTIFICATIONS_URL}/activity${query}`, { token: user.token }), 200).body as {
    items: { type: string; data: Record<string, any> }[];
  };
}

export function connect(user: User): Socket {
  return io(NOTIFICATIONS_URL, { auth: { token: user.token }, transports: ['websocket'], reconnection: false, forceNew: true });
}

export function nextEvent<T = any>(socket: Socket, event: string, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No "${event}" within ${timeoutMs} ms`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

export function waitFor<T = any>(socket: Socket, event: string, match: (payload: T) => boolean, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`No matching "${event}" within ${timeoutMs} ms`));
    }, timeoutMs);
    const listener = (payload: T) => {
      if (match(payload)) {
        clearTimeout(timer);
        socket.off(event, listener);
        resolve(payload);
      }
    };
    socket.on(event, listener);
  });
}
