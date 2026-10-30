import { Suspense } from 'react';
import { ActivityFeed } from '@/components/activity-feed';
import { Empty } from '@/components/row-list';
import { LiveTransfers } from '@/components/live-transfers';
import { LiveWallets } from '@/components/live-wallets';
import { LoadingBlock } from '@/components/loading-block';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { authedFetch } from '@/lib/server-api';
import { Dashboard } from '@/lib/types';

async function Sections() {
  const { wallets, transfers, activity } = await authedFetch<Dashboard>('/api/dashboard');
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SectionCard title="Wallets">
        {wallets.status === 'ok' ? <LiveWallets initial={wallets.data} /> : <Empty>{wallets.error}</Empty>}
      </SectionCard>
      <SectionCard title="Recent transfers">
        {transfers.status === 'ok' ? <LiveTransfers initial={transfers.data} /> : <Empty>{transfers.error}</Empty>}
      </SectionCard>
      <SectionCard title="Activity">
        {activity.status === 'ok' ? <ActivityFeed initial={activity.data} /> : <Empty>{activity.error}</Empty>}
      </SectionCard>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <>
      <PageTitle>Overview</PageTitle>
      <Suspense fallback={<LoadingBlock />}>
        <Sections />
      </Suspense>
    </>
  );
}
