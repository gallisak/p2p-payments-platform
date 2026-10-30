'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';
import { FormError } from './form-error';
import { SagaProgress } from './saga-progress';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { failureMessage, sendWithRetries } from '@/lib/send-with-retries';
import { SplitShare, Transfer, Wallet } from '@/lib/types';

const FAILED_REQUEST = 'Could not pay. Try again: it will not be duplicated.';

interface Props {
  billId: string;
  share: SplitShare;
  currency: string;
  wallets: Wallet[];
}

export function PayShare({ billId, share, currency, wallets }: Props) {
  const router = useRouter();
  const usable = wallets.filter((w) => w.currency === currency && !w.blocked);
  const [fromWalletId, setFromWalletId] = useState(usable[0]?.id ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Transfer | null>(null);
  const [settled, setSettled] = useState(false);
  const key = useRef<string | null>(null);

  const onSettled = useCallback(() => {
    setSettled(true);
    router.refresh();
  }, [router]);

  async function pay() {
    key.current ??= crypto.randomUUID();
    setSending(true);
    setError(null);
    setSent(null);
    setSettled(false);
    try {
      const res = await sendWithRetries(`/api/split-bills/${billId}/shares/${share.id}/pay`, key.current, {
        fromWalletId,
      });
      if (res.ok) {
        setSent((await res.json()) as Transfer);
        key.current = null;
      } else {
        setError(await failureMessage(res, FAILED_REQUEST));
        if (res.status < 500 && res.status !== 429) {
          key.current = null;
        }
      }
    } catch {
      setError(FAILED_REQUEST);
    } finally {
      setSending(false);
    }
  }

  if (usable.length === 0) {
    return <p className="text-muted-foreground">You need a {currency} wallet to pay.</p>;
  }
  return (
    <div className="grid w-full gap-2">
      {(!sent || settled) && (
        <div className="flex flex-wrap items-center gap-2">
          {usable.length > 1 && (
            <Select value={fromWalletId} onValueChange={setFromWalletId}>
              <SelectTrigger className="w-40" aria-label="Wallet">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {usable.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.currency}: {w.balance}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" onClick={pay} disabled={sending}>
            {sending ? 'Sending…' : `Pay ${share.amount} ${currency}`}
          </Button>
        </div>
      )}
      {error && <FormError>{error}</FormError>}
      {sent && <SagaProgress key={sent.id} initial={sent} onSettled={onSettled} />}
    </div>
  );
}
