import { formatCents, toCents } from '../src/ledger/money';

describe('money', () => {
  it.each([
    ['0', 0n],
    ['0.00', 0n],
    ['100', 10000n],
    ['100.5', 10050n],
    ['100.29', 10029n],
    ['-12.34', -1234n],
    ['9999999999999999.99', 999999999999999999n],
  ])('parses %s into %p cents', (input, cents) => {
    expect(toCents(input)).toBe(cents);
  });

  it.each([
    [0.29, 29n],
    [0.1, 10n],
    [1_000_000, 100000000n],
    [999999.99, 99999999n],
  ])('converts a validated number %p into %p cents', (input, cents) => {
    expect(toCents(input)).toBe(cents);
  });

  it.each(['', 'abc', '1.234', '1e3', '1,00', ' 1.00'])(
    'rejects malformed decimal %p',
    (input) => {
      expect(() => toCents(input)).toThrow('Invalid amount');
    },
  );

  it.each([0.004, 1e-7, 5e-324, 1.005, 0.1 + 0.2, 123.456])(
    'refuses to round %p silently',
    (input) => {
      expect(() => toCents(input)).toThrow('Invalid amount');
    },
  );

  it('rejects numbers beyond safe integer cents', () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER)).toThrow('Invalid amount');
  });

  it('rejects non-finite numbers', () => {
    expect(() => toCents(Number.NaN)).toThrow('Invalid amount');
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow('Invalid amount');
  });

  it.each([
    [0n, '0.00'],
    [5n, '0.05'],
    [10029n, '100.29'],
    [-1234n, '-12.34'],
    [-5n, '-0.05'],
  ])('formats %p cents as %s', (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });

  it('round-trips without floating point drift', () => {
    let cents = 0n;
    for (let i = 0; i < 1000; i++) cents += toCents(0.1);
    expect(formatCents(cents)).toBe('100.00');
  });
});
