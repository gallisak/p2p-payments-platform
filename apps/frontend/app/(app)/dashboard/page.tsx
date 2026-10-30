import { Suspense } from 'react';
import { Empty } from '@/components/row-list';
import { LiveWallets } from '@/components/live-wallets';
import { LoadingBlock } from '@/components/loading-block';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { authedFetch } from '@/lib/server-api';
import { Dashboard } from '@/lib/types';

async function Sections() {
  const { wallets } = await authedFetch<Dashboard>('/api/dashboard');
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SectionCard title="Wallets">
        {wallets.status === 'ok' ? <LiveWallets initial={wallets.data} /> : <Empty>{wallets.error}</Empty>}
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
