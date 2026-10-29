import { convertCents, crossRate, formatMicro, parseMicro } from '../src/fx/fx';
import { FxService, ratesFromEnv } from '../src/fx/fx.service';

describe('FX', () => {
  const perUsd = { USD: 1, EUR: 0.92, UAH: 41.5 };

  it('computes cross rates with six decimals', () => {
    expect(formatMicro(crossRate(perUsd, 'USD', 'EUR'))).toBe('0.920000');
    expect(formatMicro(crossRate(perUsd, 'EUR', 'UAH'))).toBe('45.108696');
    expect(formatMicro(crossRate(perUsd, 'UAH', 'UAH'))).toBe('1.000000');
  });

  it('rejects unknown currencies', () => {
    expect(() => crossRate(perUsd, 'USD', 'GBP')).toThrow('No rate');
  });

  it('converts cents with half-up rounding in integer arithmetic', () => {
    expect(convertCents(10_000n, parseMicro('0.920000'))).toBe(9_200n);
    expect(convertCents(1n, parseMicro('0.5'))).toBe(1n);
    expect(convertCents(1n, parseMicro('0.499999'))).toBe(0n);
    expect(convertCents(99_999_999n, parseMicro('41.5'))).toBe(4_149_999_959n);
  });

  it('round-trips rates', () => {
    expect(formatMicro(parseMicro('45.108696'))).toBe('45.108696');
    expect(() => parseMicro('-1')).toThrow();
    expect(() => parseMicro('1.1234567')).toThrow();
  });

  describe('rates from the environment', () => {
    afterEach(() => {
      delete process.env.FX_RATES_PER_USD;
    });

    it('uses the configured rates', () => {
      process.env.FX_RATES_PER_USD = '{"USD":1,"EUR":0.9,"UAH":40}';
      expect(ratesFromEnv()).toEqual({ USD: 1, EUR: 0.9, UAH: 40 });
    });

    it.each([
      ['not JSON', 'nope'],
      ['not an object', '[1,2]'],
      ['missing a supported currency', '{"USD":1,"EUR":0.9}'],
      ['a non-positive rate', '{"USD":1,"EUR":0,"UAH":40}'],
      ['a non-numeric rate', '{"USD":1,"EUR":"0.9","UAH":40}'],
    ])('refuses rates that are %s when the service starts', (_name, raw) => {
      process.env.FX_RATES_PER_USD = raw;
      expect(() => new FxService()).toThrow('FX_RATES_PER_USD');
    });
  });

  describe('FxService', () => {
    afterEach(() => {
      jest.useRealTimers();
      delete process.env.FX_CACHE_TTL_MS;
      delete process.env.FX_QUOTE_TTL_MS;
    });

    it('caches rates for the TTL and dates quotes from when the rates were fetched', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      process.env.FX_CACHE_TTL_MS = '60000';
      process.env.FX_QUOTE_TTL_MS = '90000';
      const source = jest.fn(async () => perUsd);
      const fx = new FxService(source);

      const first = await fx.quote('USD', 'EUR');
      jest.setSystemTime(1_059_999);
      const cached = await fx.quote('EUR', 'USD');
      jest.setSystemTime(1_060_000);
      const refreshed = await fx.quote('USD', 'EUR');

      expect(source).toHaveBeenCalledTimes(2);
      expect(first).toEqual({
        from: 'USD',
        to: 'EUR',
        rate: '0.920000',
        expiresAt: new Date(1_090_000),
      });
      expect(cached.expiresAt).toEqual(new Date(1_090_000));
      expect(refreshed.expiresAt).toEqual(new Date(1_150_000));
    });

    it('fetches rates once for concurrent quotes', async () => {
      const source = jest.fn(async () => perUsd);
      const fx = new FxService(source);

      await Promise.all([fx.quote('USD', 'EUR'), fx.quote('USD', 'UAH'), fx.quote('EUR', 'UAH')]);

      expect(source).toHaveBeenCalledTimes(1);
    });

    it('retries the source after a failed fetch', async () => {
      const source = jest
        .fn<Promise<Record<string, number>>, []>()
        .mockRejectedValueOnce(new Error('rates down'))
        .mockResolvedValue(perUsd);
      const fx = new FxService(source);

      await expect(fx.quote('USD', 'EUR')).rejects.toThrow('rates down');
      await expect(fx.quote('USD', 'EUR')).resolves.toMatchObject({ rate: '0.920000' });
    });
  });
});
