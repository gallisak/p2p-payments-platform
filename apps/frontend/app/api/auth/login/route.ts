import { NextRequest, NextResponse } from 'next/server';
import { bffFetch } from '@/lib/bff';
import { TokenPair, authError, readJson, withSession } from '@/lib/session';

// Proxies to the BFF so tokens live in httpOnly cookies, not in localStorage.
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (body === undefined) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  try {
    const clientIp = req.headers.get('x-forwarded-for');
    const proxySecret = process.env.PROXY_SECRET;
    const tokens: TokenPair = await bffFetch<TokenPair>('/api/auth/login', {
      method: 'POST',
      headers: {
        ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}),
        ...(proxySecret ? { 'X-Proxy-Secret': proxySecret } : {}),
      },
      body: JSON.stringify(body),
    });
    return withSession(req, NextResponse.json({ ok: true }), tokens);
  } catch (err) {
    return authError(err, 'invalid_credentials');
  }
}
