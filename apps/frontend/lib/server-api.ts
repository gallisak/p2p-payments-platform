import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { BffApiError, bffFetch, bffRequest } from './bff';
import { TokenClaims, claimsOf } from './jwt';
import { ACCESS_COOKIE } from './session';

function accessToken(): string | undefined {
  return cookies().get(ACCESS_COOKIE)?.value;
}

export function currentUser(): TokenClaims | null {
  const token = accessToken();
  return token ? claimsOf(token) : null;
}

export async function authedFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const token = accessToken();
  if (!token) {
    redirect('/login');
  }
  try {
    return await bffFetch<T>(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err instanceof BffApiError && err.status === 401) {
      redirect('/login');
    }
    throw err;
  }
}

export async function proxyToBff(path: string, init?: RequestInit): Promise<NextResponse> {
  const token = accessToken();
  if (!token) {
    return NextResponse.json({ message: 'Your session has ended' }, { status: 401 });
  }
  let res: Response;
  try {
    res = await bffRequest(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  } catch {
    return NextResponse.json({ message: 'The service is temporarily unavailable' }, { status: 503 });
  }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const name of ['Idempotent-Replayed', 'Retry-After']) {
    const value = res.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new NextResponse(await res.text(), { status: res.status, headers });
}

export function errorText(err: unknown, fallback: string): string {
  return err instanceof BffApiError && err.status < 500 ? (err.detail ?? fallback) : fallback;
}
