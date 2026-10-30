import Link from 'next/link';
import { PageTitle } from '@/components/page-title';
import { Amount, Empty, Row, RowList } from '@/components/row-list';
import { SectionCard } from '@/components/section-card';
import { SplitBillForm } from '@/components/split-bill-form';
import { Badge } from '@/components/ui/badge';
import { authedFetch } from '@/lib/server-api';
import { BILL_STATUS } from '@/lib/split-text';
import { SplitBill } from '@/lib/types';

export default async function SplitBillsPage() {
  const bills = await authedFetch<SplitBill[]>('/api/split-bills');
  return (
    <>
      <PageTitle>Split bills</PageTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <SectionCard title="New bill">
          <SplitBillForm />
        </SectionCard>
        <SectionCard title="My bills">
          {bills.length === 0 && <Empty>No bills yet.</Empty>}
          <RowList>
            {bills.map((b) => (
              <Row key={b.id}>
                <Link href={`/split-bills/${b.id}`} className="underline underline-offset-4">
                  {b.title}
                </Link>
                <span className="flex items-center gap-2">
                  <Amount>
                    {b.totalAmount} {b.currency}
                  </Amount>
                  <Badge variant="outline">{BILL_STATUS[b.status] ?? b.status}</Badge>
                </span>
              </Row>
            ))}
          </RowList>
        </SectionCard>
      </div>
    </>
  );
}
