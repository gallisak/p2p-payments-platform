import { LiveWallets } from '@/components/live-wallets';
import { PageTitle } from '@/components/page-title';
import { SectionCard } from '@/components/section-card';
import { DepositForm, OpenWalletForm } from '@/components/wallet-forms';
import { authedFetch } from '@/lib/server-api';
import { Wallet } from '@/lib/types';

export default async function WalletsPage() {
  const wallets = await authedFetch<Wallet[]>('/api/wallets');

  return (
    <>
      <PageTitle>My wallets</PageTitle>
      <SectionCard title="Balances">
        <LiveWallets initial={wallets} />
      </SectionCard>
      <SectionCard title="Manage">
        <OpenWalletForm />
        <DepositForm wallets={wallets} />
      </SectionCard>
    </>
  );
}
