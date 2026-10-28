import { NextRequest, NextResponse } from 'next/server';
import { LedgerApiError } from './api';

export const ACCESS_COOKIE = 'accessToken';
export const REFRESH_COOKIE = 'refreshToken';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type AuthErrorCode =
  | 'invalid_input'
  | 'invalid_credentials'
  | 'email_taken'
  | 'too_many_attempts'
  | 'unavailable';

function secondsUntilExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as { exp?: number };
    if (typeof payload.exp !== 'number') return undefined;
    return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
  } catch {
    return undefined;
  }
}

function isHttps(req: NextRequest): boolean {
  return (
    req.nextUrl.protocol === 'https:' ||
    req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
  );
}

function cookieOptions(req: NextRequest, token: string) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isHttps(req),
    path: '/',
    maxAge: secondsUntilExpiry(token),
  };
}

export function withSession(
  req: NextRequest,
  res: NextResponse,
  tokens: TokenPair,
): NextResponse {
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(req, tokens.accessToken));
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(req, tokens.refreshToken));
  return res;
}

export function withoutSession(res: NextResponse): NextResponse {
  res.cookies.delete(ACCESS_COOKIE);
  res.cookies.delete(REFRESH_COOKIE);
  return res;
}

export function authError(err: unknown, fallback: AuthErrorCode): NextResponse {
  const status = err instanceof LedgerApiError ? err.status : 503;
  const byStatus: Record<number, AuthErrorCode> = {
    400: 'invalid_input',
    401: 'invalid_credentials',
    409: 'email_taken',
    429: 'too_many_attempts',
  };
  const error = byStatus[status] ?? (status >= 500 ? 'unavailable' : fallback);
  const responseStatus = error === 'unavailable' ? 503 : status;
  return NextResponse.json({ error }, { status: responseStatus });
}

export async function readJson(req: NextRequest): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
