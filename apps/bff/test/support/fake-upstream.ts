import { IncomingMessage, Server, ServerResponse, createServer } from 'http';
import { AddressInfo } from 'net';

export interface Received {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export class FakeUpstream {
  readonly received: Received[] = [];
  private routes = new Map<string, (r: Received) => Reply>();
  private server?: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((resolve) => this.server?.close(resolve));
  }

  on(method: string, path: string, reply: Reply | ((r: Received) => Reply)): void {
    this.routes.set(`${method} ${path}`, typeof reply === 'function' ? reply : () => reply);
  }

  reset(): void {
    this.routes.clear();
    this.received.length = 0;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake');
    const received: Received = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    this.received.push(received);
    const route = this.routes.get(`${received.method} ${received.path}`);
    const reply = route ? route(received) : { status: 404, body: { message: 'not found' } };
    if (reply.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    }
    if (res.destroyed) return;
    res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
    res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
  }
}
