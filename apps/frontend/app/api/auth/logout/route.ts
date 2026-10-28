import { NextResponse } from 'next/server';
import { withoutSession } from '@/lib/session';

export async function POST() {
  return withoutSession(
    new NextResponse(null, { status: 303, headers: { Location: '/login' } }),
  );
}
