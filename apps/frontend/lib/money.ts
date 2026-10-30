export function parseAmount(value: unknown): number | null {
  const text = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return null;
  }
  const amount = Number(text);
  return amount > 0 ? amount : null;
}
