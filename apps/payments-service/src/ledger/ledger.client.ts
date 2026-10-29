import { Injectable } from '@nestjs/common';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { LedgerRejectedError, LedgerUnavailableError } from './ledger.errors';
import { numberEnv, requireEnv } from '../common/env';

export const LEDGER_CLIENT = Symbol('LEDGER_CLIENT');

export interface LedgerWallet {
  walletId: string;
  ownerId: string;
  currency: string;
  blocked: boolean;
}

export interface PlaceHoldRequest {
  holdId: string;
  walletId: string;
  ownerId: string;
  amount: string;
}

export interface CaptureHoldRequest {
  toWalletId: string;
  amount: string;
  currency: string;
}

export interface LedgerHold {
  id: string;
  walletId: string;
  amount: string;
  currency: string;
  status: string;
}

export interface LedgerPort {
  getWallet(walletId: string, ownerId: string): Promise<LedgerWallet>;
  resolveRecipient(email: string, currency: string): Promise<LedgerWallet>;
  placeHold(request: PlaceHoldRequest): Promise<LedgerHold>;
  releaseHold(holdId: string, walletId: string): Promise<LedgerHold>;
  captureHold(holdId: string, request: CaptureHoldRequest): Promise<LedgerHold>;
}

const TRANSIENT_STATUSES = new Set([408, 429]);

@Injectable()
export class LedgerClient implements LedgerPort {
  private readonly baseUrl = requireEnv('LEDGER_SERVICE_URL').replace(/\/+$/, '');
  private readonly apiKey = requireEnv('INTERNAL_API_KEY');
  private readonly timeoutMs = numberEnv('LEDGER_TIMEOUT_MS', 3_000);
  readonly breaker = new CircuitBreaker({
    failureThreshold: numberEnv('LEDGER_BREAKER_FAILURES', 5),
    openMs: numberEnv('LEDGER_BREAKER_OPEN_MS', 5_000),
  });

  getWallet(walletId: string, ownerId: string): Promise<LedgerWallet> {
    return this.call(
      'GET',
      `/internal/wallets/${encodeURIComponent(walletId)}?ownerId=${encodeURIComponent(ownerId)}`,
    );
  }

  resolveRecipient(email: string, currency: string): Promise<LedgerWallet> {
    return this.call('POST', '/internal/recipients', { email, currency });
  }

  placeHold(request: PlaceHoldRequest): Promise<LedgerHold> {
    return this.call('POST', '/internal/holds', { ...request, amount: Number(request.amount) });
  }

  releaseHold(holdId: string, walletId: string): Promise<LedgerHold> {
    return this.call('POST', `/internal/holds/${encodeURIComponent(holdId)}/release`, {
      walletId,
    });
  }

  captureHold(holdId: string, request: CaptureHoldRequest): Promise<LedgerHold> {
    return this.call('POST', `/internal/holds/${encodeURIComponent(holdId)}/capture`, {
      ...request,
      amount: Number(request.amount),
    });
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    try {
      return await this.breaker.exec(
        () => this.send<T>(method, path, body),
        (err) => err instanceof LedgerUnavailableError,
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new LedgerUnavailableError('ledger-service circuit is open', err.retryInMs);
      }
      throw err;
    }
  }

  private async send<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-internal-api-key': this.apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new LedgerUnavailableError(`ledger-service unreachable: ${(err as Error).message}`);
    }
    if (res.ok) {
      return JSON.parse(text) as T;
    }
    if (res.status >= 500 || TRANSIENT_STATUSES.has(res.status)) {
      throw new LedgerUnavailableError(`ledger-service responded ${res.status}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new LedgerUnavailableError(`ledger-service refused the internal API key (${res.status})`);
    }
    throw new LedgerRejectedError(res.status, errorMessage(text) ?? `ledger-service responded ${res.status}`);
  }
}

function errorMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
    if (Array.isArray(parsed.message)) {
      return parsed.message.join('; ');
    }
  } catch {
    return text || undefined;
  }
  return undefined;
}
