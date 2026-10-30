import { Skeleton } from '@/components/ui/skeleton';

export function LoadingBlock() {
  return <Skeleton role="status" aria-label="Loading" className="h-28 w-full" />;
}
