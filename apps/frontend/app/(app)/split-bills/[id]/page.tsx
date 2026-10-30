import { notFound } from 'next/navigation';
import { PageTitle } from '@/components/page-title';
import { PayShare } from '@/components/pay-share';
import { Amount, Row, RowList } from '@/components/row-list';
import { SectionCard } from '@/components/section-card';
import { Badge } from '@/components/ui/badge';
import { BffApiError } from '@/lib/bff';
import { authedFetch, currentUser } from '@/lib/server-api';
import { BILL_STATUS, SHARE_STATUS } from '@/lib/split-text';
import { SplitBill, Wallet } from '@/lib/types';

async function loadBill(id: string): Promise<SplitBill> {
  try {
    return await authedFetch<SplitBill>(`/api/split-bills/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof BffApiError && (err.status === 400 || err.status === 403 || err.status === 404)) {
      notFound();
    }
    throw err;
  }
}

export default async function SplitBillPage({ params }: { params: { id: string } }) {
  const [bill, wallets] = await Promise.all([loadBill(params.id), authedFetch<Wallet[]>('/api/wallets')]);
  const userId = currentUser()?.sub;
  return (
    <>
      <PageTitle>{bill.title}</PageTitle>
      <SectionCard title="Summary">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Amount>
            {bill.totalAmount} {bill.currency}
          </Amount>
          <Badge variant="outline">{BILL_STATUS[bill.status] ?? bill.status}</Badge>
        </p>
        <p className="text-sm text-muted-foreground">
          Created by {bill.creatorEmail}. Due {bill.dueAt.slice(0, 10)}.
        </p>
      </SectionCard>
      <SectionCard title="Shares">
        <RowList>
          {bill.shares.map((share) => (
            <Row key={share.id}>
              <span>{share.participantEmail}</span>
              <span className="flex items-center gap-2">
                <Amount>
                  {share.amount} {bill.currency}
                </Amount>
                <Badge variant="outline" className={share.status === 'paid' ? 'border-success text-success' : undefined}>
                  {SHARE_STATUS[share.status] ?? share.status}
                </Badge>
              </span>
              {share.participantId === userId && share.status === 'pending' && (
                <PayShare billId={bill.id} share={share} currency={bill.currency} wallets={wallets} />
              )}
            </Row>
          ))}
        </RowList>
      </SectionCard>
    </>
  );
}
