import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { FormError } from '@/components/form-error';
import { LoadingBlock } from '@/components/loading-block';
import { PageTitle } from '@/components/page-title';
import { Empty, Row, RowList } from '@/components/row-list';
import { SectionCard } from '@/components/section-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BffApiError } from '@/lib/bff';
import { authedFetch, currentUser } from '@/lib/server-api';

interface Reconciliation {
  ok: boolean;
  totals: { currency: string; debits: string; credits: string; net: string }[];
  unbalancedOperations: unknown[];
  projections: { checked: number; mismatches: unknown[] };
}

interface LedgerEvent {
  position: string;
  streamVersion: number;
  type: string;
  payload: unknown;
  occurredAt: string;
}

interface TraceSummary {
  traceId: string;
  startedAt: string;
  durationMs: number;
  services: string[];
  transferId: string | null;
  steps: { step: string; outcome: string; attempt: number; durationMs: number }[];
  spans: { service: string; operation: string; startOffsetMs: number; durationMs: number; error: boolean }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ReconciliationSection() {
  let report: Reconciliation;
  try {
    report = await authedFetch<Reconciliation>('/api/admin/reconciliation');
  } catch {
    return <FormError>Could not load the reconciliation report.</FormError>;
  }
  return (
    <>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        {report.ok ? (
          <Badge variant="outline" className="border-success text-success">
            Balanced
          </Badge>
        ) : (
          <Badge variant="destructive">Discrepancies found</Badge>
        )}
        <span className="text-muted-foreground">
          Wallets checked: {report.projections.checked}, mismatches: {report.projections.mismatches.length}, unbalanced
          operations: {report.unbalancedOperations.length}
        </span>
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Currency</TableHead>
            <TableHead>Debits</TableHead>
            <TableHead>Credits</TableHead>
            <TableHead>Net</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.totals.map((t) => (
            <TableRow key={t.currency}>
              <TableCell>{t.currency}</TableCell>
              <TableCell>{t.debits}</TableCell>
              <TableCell>{t.credits}</TableCell>
              <TableCell>{t.net}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

async function TracesSection() {
  let traces: TraceSummary[];
  try {
    traces = await authedFetch<TraceSummary[]>('/api/admin/traces?limit=10');
  } catch {
    return <FormError>Traces are temporarily unavailable.</FormError>;
  }
  if (traces.length === 0) {
    return <Empty>No transfers in the last hour.</Empty>;
  }
  return (
    <RowList>
      {traces.map((t) => (
        <Row key={t.traceId}>
          <details className="w-full min-w-0">
            <summary className="cursor-pointer">
              <code className="text-xs">{t.traceId.slice(0, 12)}</code> {t.startedAt.slice(11, 19)} UTC, {t.durationMs} ms,{' '}
              {t.services.length} services
            </summary>
            <ol className="my-2 flex flex-wrap gap-1.5">
              {t.steps.map((s, index) => (
                <li key={index}>
                  <Badge variant={s.outcome === 'advance' ? 'outline' : 'destructive'}>
                    {s.step}: {s.durationMs} ms
                  </Badge>
                </li>
              ))}
            </ol>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Start, ms</TableHead>
                  <TableHead>Duration, ms</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.spans.map((s, index) => (
                  <TableRow key={index} className={s.error ? 'text-destructive' : undefined}>
                    <TableCell>{s.service}</TableCell>
                    <TableCell>{s.operation}</TableCell>
                    <TableCell>{s.startOffsetMs}</TableCell>
                    <TableCell>{s.durationMs}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </details>
        </Row>
      ))}
    </RowList>
  );
}

async function EventLog({ walletId }: { walletId: string }) {
  let events: LedgerEvent[];
  try {
    events = await authedFetch<LedgerEvent[]>(`/api/admin/wallets/${walletId}/events`);
  } catch (err) {
    const missing = err instanceof BffApiError && err.status === 404;
    return <FormError>{missing ? 'Wallet not found.' : 'Could not load the event log.'}</FormError>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Data</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => (
          <TableRow key={e.position}>
            <TableCell>{e.streamVersion}</TableCell>
            <TableCell>{e.occurredAt}</TableCell>
            <TableCell>{e.type}</TableCell>
            <TableCell>
              <pre className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{JSON.stringify(e.payload)}</pre>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function AdminPage({ searchParams }: { searchParams: { wallet?: string | string[] } }) {
  if (currentUser()?.role !== 'admin') {
    redirect('/dashboard');
  }
  const wallet = typeof searchParams.wallet === 'string' ? searchParams.wallet.trim() : '';
  return (
    <>
      <PageTitle>Admin</PageTitle>
      <SectionCard title="Reconciliation">
        <Suspense fallback={<LoadingBlock />}>
          <ReconciliationSection />
        </Suspense>
      </SectionCard>
      <SectionCard title="Latest transfer traces">
        <Suspense fallback={<LoadingBlock />}>
          <TracesSection />
        </Suspense>
      </SectionCard>
      <SectionCard title="Wallet event log">
        <form className="flex flex-wrap items-center gap-2" method="get">
          <Input name="wallet" defaultValue={wallet} placeholder="Wallet ID" aria-label="Wallet ID" className="max-w-sm" />
          <Button type="submit">Show</Button>
        </form>
        {wallet && !UUID.test(wallet) && <FormError>Enter a valid wallet ID.</FormError>}
        {UUID.test(wallet) && (
          <Suspense key={wallet} fallback={<LoadingBlock />}>
            <EventLog walletId={wallet} />
          </Suspense>
        )}
      </SectionCard>
    </>
  );
}
