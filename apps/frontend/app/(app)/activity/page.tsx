import Link from 'next/link';
import { Suspense } from 'react';
import { ActivityFeed } from '@/components/activity-feed';
import { LoadingBlock } from '@/components/loading-block';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { Button } from '@/components/ui/button';
import { ACTIVITY_LABELS } from '@/lib/activity-text';
import { authedFetch } from '@/lib/server-api';
import { ActivityPage } from '@/lib/types';

async function Feed({ type }: { type?: string }) {
  const query = new URLSearchParams(type ? { type } : {});
  const page = await authedFetch<ActivityPage>(`/api/activity?${query}`);
  return <ActivityFeed key={type ?? 'all'} initial={page} type={type} pageable />;
}

export default function ActivityRoute({ searchParams }: { searchParams: { type?: string } }) {
  const type =
    searchParams.type && Object.keys(ACTIVITY_LABELS).includes(searchParams.type) ? searchParams.type : undefined;
  const filters = [{ value: undefined, label: 'All' }, ...Object.entries(ACTIVITY_LABELS).map(([value, label]) => ({ value, label }))];
  return (
    <>
      <PageTitle>Activity</PageTitle>
      <nav aria-label="Filter by type" className="flex flex-wrap gap-1.5">
        {filters.map(({ value, label }) => (
          <Button key={label} variant={type === value ? 'default' : 'outline'} size="sm" asChild>
            <Link href={value ? `/activity?type=${value}` : '/activity'} aria-current={type === value}>
              {label}
            </Link>
          </Button>
        ))}
      </nav>
      <SectionCard title="Events">
        <Suspense key={type ?? 'all'} fallback={<LoadingBlock />}>
          <Feed type={type} />
        </Suspense>
      </SectionCard>
    </>
  );
}
