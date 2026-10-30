import { PageTitle } from '@/components/page-title';
import { Amount, Empty, Row, RowList } from '@/components/row-list';
import { SectionCard } from '@/components/section-card';
import { authedFetch } from '@/lib/server-api';

interface WalletView {
  id: string;
  currency: string;
  balance: string;
}

export default async function WalletsPage() {
  const wallets = await authedFetch<WalletView[]>('/api/wallets');

  return (
    <>
      <PageTitle>My wallets</PageTitle>
      <SectionCard title="Balances">
        {wallets.length === 0 && <Empty>No wallets yet.</Empty>}
        <RowList>
          {wallets.map((w) => (
            <Row key={w.id}>
              <span>{w.currency}</span>
              <Amount>{w.balance}</Amount>
            </Row>
          ))}
        </RowList>
      </SectionCard>
    </>
  );
}
