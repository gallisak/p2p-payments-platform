import { Inject, Injectable, Optional } from '@nestjs/common';
import { crossRate, formatMicro } from './fx';
import { numberEnv } from '../common/env';
import { SUPPORTED_CURRENCIES } from '../common/currencies';

export const FX_RATES_SOURCE = Symbol('FX_RATES_SOURCE');

export type RatesSource = () => Promise<Record<string, number>>;

export interface FxQuote {
  from: string;
  to: string;
  rate: string;
  expiresAt: Date;
}

const DEFAULT_RATES_PER_USD: Record<string, number> = { USD: 1, EUR: 0.92, UAH: 41.5 };

export function ratesFromEnv(): Record<string, number> {
  const raw = process.env.FX_RATES_PER_USD;
  if (!raw) {
    return DEFAULT_RATES_PER_USD;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FX_RATES_PER_USD must be a JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('FX_RATES_PER_USD must be a JSON object');
  }
  const rates = parsed as Record<string, unknown>;
  for (const currency of SUPPORTED_CURRENCIES) {
    const rate = rates[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`FX_RATES_PER_USD has no valid rate for ${currency}`);
    }
  }
  return rates as Record<string, number>;
}

function staticRates(rates: Record<string, number>): RatesSource {
  return async () => rates;
}

@Injectable()
export class FxService {
  private readonly cacheTtlMs = numberEnv('FX_CACHE_TTL_MS', 60_000);
  private readonly quoteTtlMs = numberEnv('FX_QUOTE_TTL_MS', 120_000);
  private cached?: { rates: Record<string, number>; fetchedAt: number };
  private inflight?: Promise<{ rates: Record<string, number>; fetchedAt: number }>;

  constructor(
    @Optional()
    @Inject(FX_RATES_SOURCE)
    private readonly source: RatesSource = staticRates(ratesFromEnv()),
  ) {}

  async quote(from: string, to: string): Promise<FxQuote> {
    const { rates, fetchedAt } = await this.rates();
    return {
      from,
      to,
      rate: formatMicro(crossRate(rates, from, to)),
      expiresAt: new Date(fetchedAt + this.quoteTtlMs),
    };
  }

  private async rates(): Promise<{ rates: Record<string, number>; fetchedAt: number }> {
    if (this.cached && Date.now() - this.cached.fetchedAt < this.cacheTtlMs) {
      return this.cached;
    }
    this.inflight ??= this.source()
      .then((rates) => {
        this.cached = { rates, fetchedAt: Date.now() };
        return this.cached;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
