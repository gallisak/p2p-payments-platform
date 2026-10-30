import { NextRequest, NextResponse } from 'next/server';
import { bffRequest } from './lib/bff';
import { secondsUntilExpiry } from './lib/jwt';
import { ACCESS_COOKIE, REFRESH_COOKIE, TokenPair, withSession } from './lib/session';

const EXPIRY_MARGIN_SECONDS = 30;
const REFRESH_REUSE_MS = 10_000;

const recentRefreshes = new Map<string, Promise<TokenPair | null>>();

async function refreshed(refreshToken: string): Promise<TokenPair | null> {
  try {
    const res = await bffRequest('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    return res.ok ? ((await res.json()) as TokenPair) : null;
  } catch {
    return null;
  }
}

function refreshOnce(refreshToken: string): Promise<TokenPair | null> {
  const known = recentRefreshes.get(refreshToken);
  if (known) {
    return known;
  }
  const result = refreshed(refreshToken);
  recentRefreshes.set(refreshToken, result);
  setTimeout(() => recentRefreshes.delete(refreshToken), REFRESH_REUSE_MS);
  return result;
}

function forward(req: NextRequest, tokens: TokenPair): NextResponse {
  req.cookies.set(ACCESS_COOKIE, tokens.accessToken);
  req.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
  const headers = new Headers(req.headers);
  headers.set('cookie', req.cookies.toString());
  return withSession(req, NextResponse.next({ request: { headers } }), tokens);
}

export async function middleware(req: NextRequest) {
  const access = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  if (access && (secondsUntilExpiry(access) ?? 0) > EXPIRY_MARGIN_SECONDS) {
    return NextResponse.next();
  }
  const tokens = refresh ? await refreshOnce(refresh) : null;
  if (tokens) {
    return forward(req, tokens);
  }
  if (access) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ message: 'Your session has ended' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!_next/|favicon.ico|login|register|api/auth/).*)'],
};
