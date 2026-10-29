const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(value: string | number): bigint {
  if (typeof value === 'number') {
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || cents / 100 !== value) {
      throw new Error(`Invalid amount: ${value}`);
    }
    return BigInt(cents);
  }
  const match = DECIMAL_RE.exec(value);
  if (!match) {
    throw new Error(`Invalid amount: ${value}`);
  }
  const [, sign, units, fraction = ''] = match;
  const cents = BigInt(units) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const units = abs / 100n;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${units}.${fraction}`;
}
