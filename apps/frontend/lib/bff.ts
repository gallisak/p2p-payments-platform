const BFF_URL = process.env.BFF_URL ?? 'http://localhost:3004';

export class BffApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`BFF ${status}`);
  }

  get detail(): string | undefined {
    try {
      const { message } = JSON.parse(this.body) as { message?: string | string[] };
      return Array.isArray(message) ? message.join('; ') : message;
    } catch {
      return undefined;
    }
  }
}

export function bffRequest(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BFF_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
}

export async function bffFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await bffRequest(path, init);
  if (!res.ok) {
    throw new BffApiError(res.status, await res.text());
  }
  return (await res.json()) as T;
}
