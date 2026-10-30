import { NextRequest, NextResponse } from 'next/server';
import { proxyToBff } from '@/lib/server-api';
import { readJson } from '@/lib/session';

export async function POST(req: NextRequest, { params }: { params: { id: string; shareId: string } }) {
  const body = await readJson(req);
  if (body === undefined) {
    return NextResponse.json({ message: 'Invalid request' }, { status: 400 });
  }
  const path = `/api/split-bills/${encodeURIComponent(params.id)}/shares/${encodeURIComponent(params.shareId)}/pay`;
  return proxyToBff(path, {
    method: 'POST',
    headers: { 'Idempotency-Key': req.headers.get('idempotency-key') ?? '' },
    body: JSON.stringify(body),
  });
}
