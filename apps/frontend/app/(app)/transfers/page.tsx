import { LiveTransfers } from '@/components/live-transfers';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { TransferForm } from '@/components/transfer-form';
import { authedFetch } from '@/lib/server-api';
import { Transfer, Wallet } from '@/lib/types';

export default async function TransfersPage() {
  const [wallets, transfers] = await Promise.all([
    authedFetch<Wallet[]>('/api/wallets'),
    authedFetch<Transfer[]>('/api/transfers?limit=10'),
  ]);

  return (
    <>
      <PageTitle>Transfers</PageTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="New transfer">
          <TransferForm wallets={wallets} />
        </SectionCard>
        <SectionCard title="Recent transfers">
          <LiveTransfers initial={transfers} />
        </SectionCard>
      </div>
    </>
  );
}
