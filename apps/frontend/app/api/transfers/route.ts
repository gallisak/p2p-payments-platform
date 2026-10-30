import { NextRequest, NextResponse } from 'next/server';
import { proxyToBff } from '@/lib/server-api';
import { readJson } from '@/lib/session';

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (body === undefined) {
    return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
  }
  return proxyToBff('/api/transfers', {
    method: 'POST',
    headers: { 'Idempotency-Key': req.headers.get('idempotency-key') ?? '' },
    body: JSON.stringify(body),
  });
}
