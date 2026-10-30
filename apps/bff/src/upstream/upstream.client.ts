import { Injectable } from '@nestjs/common';
import { numberEnv, requireEnv } from '../common/env';

export type Service = 'ledger' | 'payments' | 'notifications';
export type Upstream = Service | 'jaeger';

export interface UpstreamRequest {
  authorization?: string;
  idempotencyKey?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
  slow?: boolean;
}

export interface UpstreamResponse {
  status: number;
  body: unknown;
  replayed?: string;
  retryAfter?: string;
}

export class UpstreamUnavailableError extends Error {
  constructor(
    readonly upstream: Upstream,
    reason: string,
  ) {
    super(`${upstream}-service недоступний: ${reason}`);
  }
}

@Injectable()
export class UpstreamClient {
  private readonly baseUrls: Record<Upstream, string> = {
    ledger: requireEnv('LEDGER_SERVICE_URL').replace(/\/+$/, ''),
    payments: requireEnv('PAYMENTS_SERVICE_URL').replace(/\/+$/, ''),
    notifications: requireEnv('NOTIFICATIONS_SERVICE_URL').replace(/\/+$/, ''),
    jaeger: requireEnv('JAEGER_QUERY_URL').replace(/\/+$/, ''),
  };
  private readonly timeoutMs = Math.max(1, numberEnv('UPSTREAM_TIMEOUT_MS', 5_000));
  private readonly adminTimeoutMs = Math.max(1, numberEnv('ADMIN_UPSTREAM_TIMEOUT_MS', 60_000));

  async request(
    upstream: Upstream,
    method: 'GET' | 'POST',
    path: string,
    options: UpstreamRequest = {},
  ): Promise<UpstreamResponse> {
    const url = new URL(`${this.baseUrls[upstream]}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.authorization) {
      headers.Authorization = options.authorization;
    }
    if (options.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.slow ? this.adminTimeoutMs : this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new UpstreamUnavailableError(upstream, (err as Error).message);
    }
    if (res.status >= 502 && res.status <= 504) {
      throw new UpstreamUnavailableError(upstream, `HTTP ${res.status}`);
    }
    return {
      status: res.status,
      body: parseBody(text, res.headers.get('content-type')),
      replayed: res.headers.get('idempotent-replayed') ?? undefined,
      retryAfter: res.headers.get('retry-after') ?? undefined,
    };
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) {
    return undefined;
  }
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { message: 'Некоректна відповідь сервісу' };
    }
  }
  return { message: text };
}
