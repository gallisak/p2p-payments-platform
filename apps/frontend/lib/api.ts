const LEDGER_URL = process.env.LEDGER_SERVICE_URL ?? 'http://localhost:3001';

export class LedgerApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Ledger API ${status}`);
  }
}

export async function ledgerFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${LEDGER_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new LedgerApiError(res.status, await res.text());
  }
  return res.json();
}
