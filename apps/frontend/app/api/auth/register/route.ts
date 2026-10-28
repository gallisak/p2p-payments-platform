import { NextRequest, NextResponse } from 'next/server';
import { ledgerFetch } from '@/lib/api';
import { TokenPair, authError, readJson, withSession } from '@/lib/session';

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (body === undefined) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
  }
  try {
    const tokens: TokenPair = await ledgerFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return withSession(req, NextResponse.json({ ok: true }), tokens);
  } catch (err) {
    return authError(err, 'invalid_input');
  }
}
