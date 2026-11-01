import { NextRequest, NextResponse } from 'next/server';
import { bffRequest } from '@/lib/bff';
import { REFRESH_COOKIE, withoutSession } from '@/lib/session';

function isCrossSite(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) {
    return false;
  }
  try {
    return new URL(origin).host !== req.headers.get('host');
  } catch {
    return true;
  }
}

export async function POST(req: NextRequest) {
  if (isCrossSite(req)) {
    return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
  }
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    await bffRequest('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
  return withoutSession(
    new NextResponse(null, { status: 303, headers: { Location: '/login' } }),
  );
}
