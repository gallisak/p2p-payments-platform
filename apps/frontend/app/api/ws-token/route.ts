import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/session';

export function GET() {
  const token = cookies().get(ACCESS_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ message: 'Your session has ended' }, { status: 401 });
  }
  return NextResponse.json({ token }, { headers: { 'Cache-Control': 'no-store' } });
}
