import { randomUUID } from 'crypto';
import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { AddressInfo } from 'net';
import { formatCents, toCents } from '../../src/common/money';

export interface FakeWallet {
  walletId: string;
  ownerId: string;
  currency: string;
  balance: bigint;
  held: bigint;
  blocked: boolean;
}

export interface FakeHold {
  id: string;
  walletId: string;
  amount: bigint;
  currency: string;
  status: 'placed' | 'released' | 'captured' | 'voided';
  toWalletId?: string;
  creditAmount?: bigint;
}

export type Operation = 'wallet' | 'recipient' | 'place' | 'release' | 'capture';

export interface Call {
  op: Operation;
  path: string;
  body: Record<string, unknown>;
}

export type Interceptor = (call: Call) => Promise<'continue' | 'drop' | number | void>;

export class FakeLedger {
  readonly wallets = new Map<string, FakeWallet>();
  readonly holds = new Map<string, FakeHold>();
  readonly users = new Map<string, string>();
  readonly calls: Call[] = [];
  down = false;
  responseDelayMs: Partial<Record<Operation, number>> = {};
  private interceptors: Interceptor[] = [];
  private server?: Server;

  constructor(private readonly apiKey: string) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  reset(): void {
    this.down = false;
    this.responseDelayMs = {};
    this.interceptors = [];
    this.calls.length = 0;
  }

  intercept(interceptor: Interceptor): void {
    this.interceptors.push(interceptor);
  }

  user(email: string): string {
    let id = this.users.get(email);
    if (!id) {
      id = randomUUID();
      this.users.set(email, id);
    }
    return id;
  }

  openWallet(ownerId: string, currency: string, funds = '0'): FakeWallet {
    const existing = [...this.wallets.values()].find(
      (w) => w.ownerId === ownerId && w.currency === currency,
    );
    if (existing) {
      return existing;
    }
    const wallet: FakeWallet = {
      walletId: randomUUID(),
      ownerId,
      currency,
      balance: toCents(funds),
      held: 0n,
      blocked: false,
    };
    this.wallets.set(wallet.walletId, wallet);
    return wallet;
  }

  balances(walletId: string) {
    const w = this.wallets.get(walletId) as FakeWallet;
    return { balance: formatCents(w.balance), held: formatCents(w.held) };
  }

  callsOf(op: Operation): Call[] {
    return this.calls.filter((c) => c.op === op);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const url = new URL(req.url ?? '/', 'http://fake');
    const call: Call = { op: this.operation(req.method ?? 'GET', url.pathname), path: url.pathname, body };
    this.calls.push(call);

    if (req.headers['x-internal-api-key'] !== this.apiKey) {
      return this.reply(res, 401, { message: 'Unauthorized' });
    }
    if (this.down) {
      return this.reply(res, 503, { message: 'down' });
    }
    for (const interceptor of this.interceptors) {
      const verdict = await interceptor(call);
      if (verdict === 'drop') {
        req.socket.destroy();
        return;
      }
      if (typeof verdict === 'number') {
        return this.reply(res, verdict, { message: `injected ${verdict}` });
      }
    }
    let status = 200;
    let payload: unknown;
    try {
      payload = this.execute(call, url);
      status = req.method === 'POST' ? 201 : 200;
    } catch (err) {
      status = (err as { status?: number }).status ?? 500;
      payload = { message: (err as Error).message };
    }
    const delay = this.responseDelayMs[call.op];
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (!res.destroyed) {
      this.reply(res, status, payload);
    }
  }

  private operation(method: string, path: string): Operation {
    if (method === 'GET') return 'wallet';
    if (path === '/internal/recipients') return 'recipient';
    if (path === '/internal/holds') return 'place';
    return path.endsWith('/release') ? 'release' : 'capture';
  }

  private execute(call: Call, url: URL): unknown {
    switch (call.op) {
      case 'wallet': {
        const wallet = this.wallets.get(call.path.split('/')[3]);
        if (!wallet || wallet.ownerId !== url.searchParams.get('ownerId')) throw fail(404, 'Гаманець не знайдено');
        return this.walletView(wallet);
      }
      case 'recipient': {
        const ownerId = this.users.get(String(call.body.email));
        if (!ownerId) throw fail(404, 'Отримувача не знайдено');
        return this.walletView(this.openWallet(ownerId, String(call.body.currency)));
      }
      case 'place':
        return this.place(call.body);
      case 'release':
        return this.release(call.path.split('/')[3], call.body.walletId as string | undefined);
      case 'capture':
        return this.capture(call.path.split('/')[3], call.body);
    }
  }

  private place(body: Record<string, unknown>) {
    const wallet = this.wallets.get(String(body.walletId));
    if (!wallet || wallet.ownerId !== body.ownerId) throw fail(404, 'Гаманець не знайдено');
    const amount = toCents(Number(body.amount));
    const existing = this.holds.get(String(body.holdId));
    if (existing) {
      if (existing.status === 'voided' || existing.walletId !== wallet.walletId || existing.amount !== amount) {
        throw fail(409, 'Холд з таким id уже існує з іншими параметрами');
      }
      return this.holdView(existing);
    }
    if (wallet.blocked) throw fail(423, 'Гаманець заблоковано');
    if (wallet.balance - wallet.held < amount) throw fail(400, 'Недостатньо коштів');
    const hold: FakeHold = { id: String(body.holdId), walletId: wallet.walletId, amount, currency: wallet.currency, status: 'placed' };
    wallet.held += amount;
    this.holds.set(hold.id, hold);
    return this.holdView(hold);
  }

  private release(holdId: string, walletId?: string) {
    const hold = this.holds.get(holdId);
    if (!hold) {
      const wallet = walletId ? this.wallets.get(walletId) : undefined;
      if (!wallet) throw fail(404, 'Холд не знайдено');
      const voided: FakeHold = { id: holdId, walletId: wallet.walletId, amount: 0n, currency: wallet.currency, status: 'voided' };
      this.holds.set(holdId, voided);
      return this.holdView(voided);
    }
    if (walletId && hold.walletId !== walletId) throw fail(400, 'Холд належить іншому гаманцю');
    if (hold.status === 'captured') throw fail(409, 'Холд уже списано');
    if (hold.status === 'placed') {
      (this.wallets.get(hold.walletId) as FakeWallet).held -= hold.amount;
      hold.status = 'released';
    }
    return this.holdView(hold);
  }

  private capture(holdId: string, body: Record<string, unknown>) {
    const hold = this.holds.get(holdId);
    if (!hold) throw fail(404, 'Холд не знайдено');
    const credit = toCents(Number(body.amount));
    if (hold.status === 'captured') {
      if (hold.toWalletId === body.toWalletId && hold.creditAmount === credit) return this.holdView(hold);
      throw fail(409, 'Холд уже списано з іншими параметрами');
    }
    if (hold.status !== 'placed') throw fail(409, 'Холд уже знято');
    const sender = this.wallets.get(hold.walletId) as FakeWallet;
    const recipient = this.wallets.get(String(body.toWalletId));
    if (!recipient) throw fail(404, 'Гаманець отримувача не знайдено');
    if (recipient.currency !== body.currency) throw fail(400, 'Валюта не збігається');
    if (sender.blocked || recipient.blocked) throw fail(423, 'Гаманець заблоковано');
    sender.held -= hold.amount;
    sender.balance -= hold.amount;
    recipient.balance += credit;
    hold.status = 'captured';
    hold.toWalletId = recipient.walletId;
    hold.creditAmount = credit;
    return this.holdView(hold);
  }

  private walletView(w: FakeWallet) {
    return { walletId: w.walletId, ownerId: w.ownerId, currency: w.currency, blocked: w.blocked };
  }

  private holdView(h: FakeHold) {
    return { id: h.id, walletId: h.walletId, amount: formatCents(h.amount), currency: h.currency, status: h.status };
  }

  private reply(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

function fail(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
