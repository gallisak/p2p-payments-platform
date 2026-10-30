'use client';

import { useEffect, useState } from 'react';
import { FormError } from './form-error';
import { useRealtime } from './realtime-provider';
import { Badge } from '@/components/ui/badge';
import { SAGA_STEPS, STATUS_TEXT, failureText, isTerminal } from '@/lib/transfer-text';
import { Transfer } from '@/lib/types';
import { cn } from '@/lib/utils';

const POLL_ONLINE_MS = 5_000;
const POLL_OFFLINE_MS = 2_000;

const STEP_STYLE: Record<string, string> = {
  done: 'border-success text-success',
  active: 'border-foreground text-foreground',
  pending: 'text-muted-foreground',
};

function stepState(index: number, current: number): string {
  if (current < 0) {
    return 'pending';
  }
  if (index < current) {
    return 'done';
  }
  return index === current ? 'active' : 'pending';
}

function newest(polled: Transfer, live: Transfer | undefined): Transfer {
  return live && live.updatedAt >= polled.updatedAt ? live : polled;
}

interface Props {
  initial: Transfer;
  onSettled?: () => void;
}

export function SagaProgress({ initial, onSettled }: Props) {
  const { transfers, status: connection } = useRealtime();
  const [polled, setPolled] = useState<Transfer>(initial);
  const transfer = newest(polled, transfers[initial.id]?.transfer);
  const terminal = isTerminal(transfer.status);

  useEffect(() => {
    if (terminal) {
      onSettled?.();
    }
  }, [terminal, onSettled]);

  useEffect(() => {
    if (terminal) {
      return;
    }
    const timer = setInterval(async () => {
      const res = await fetch(`/api/transfers/${initial.id}`, { cache: 'no-store' }).catch(() => null);
      if (res?.ok) {
        setPolled((await res.json()) as Transfer);
      }
    }, connection === 'online' ? POLL_ONLINE_MS : POLL_OFFLINE_MS);
    return () => clearInterval(timer);
  }, [connection, initial.id, terminal]);

  const current = SAGA_STEPS.findIndex((s) => s.status === transfer.status);
  return (
    <div aria-live="polite" className="grid gap-2 text-sm">
      <strong data-testid="saga-status">{STATUS_TEXT[transfer.status] ?? transfer.status}</strong>
      <ol className="flex flex-wrap gap-1.5">
        {SAGA_STEPS.map((step, index) => (
          <li key={step.status}>
            <Badge
              variant="outline"
              className={cn(STEP_STYLE[transfer.status === 'completed' ? 'done' : stepState(index, current)])}
            >
              {step.label}
            </Badge>
          </li>
        ))}
      </ol>
      {transfer.awaitingRetry && <p className="text-warning">Temporary delay, the system is retrying…</p>}
      {transfer.status === 'failed' && <FormError>{failureText(transfer.failureReason)}</FormError>}
    </div>
  );
}
