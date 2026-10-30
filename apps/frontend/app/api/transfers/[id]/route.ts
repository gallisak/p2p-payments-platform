import { proxyToBff } from '@/lib/server-api';

export function GET(_req: Request, { params }: { params: { id: string } }) {
  return proxyToBff(`/api/transfers/${encodeURIComponent(params.id)}`);
}
