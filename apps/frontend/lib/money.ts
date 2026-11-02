function cents(amount: string): bigint {
  return BigInt(amount.replace('.', ''));
}

export function availableAmount({ balance, held }: { balance: string; held: string }): string {
  const available = cents(balance) - cents(held);
  return `${available / 100n}.${String(available % 100n).padStart(2, '0')}`;
}

export function parseAmount(value: unknown): number | null {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const amount = Number(text);
  return amount > 0 ? amount : null;
}
