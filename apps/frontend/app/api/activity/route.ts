import { NextRequest } from 'next/server';
import { proxyToBff } from '@/lib/server-api';

export function GET(req: NextRequest) {
  const query = new URLSearchParams();
  for (const name of ['type', 'cursor', 'limit']) {
    const value = req.nextUrl.searchParams.get(name);
    if (value) {
      query.set(name, value);
    }
  }
  return proxyToBff(`/api/activity?${query}`);
}
