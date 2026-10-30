'use client';

import { useRef, useState } from 'react';
import { FormError } from './form-error';
import { useRealtime } from './realtime-provider';
import { Empty } from './row-list';
import { SagaProgress } from './saga-progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { parseAmount } from '@/lib/money';
import { failureMessage, sendWithRetries } from '@/lib/send-with-retries';
import { CURRENCIES, Transfer, Wallet } from '@/lib/types';

const FAILED_REQUEST = 'Could not send the transfer. Try again: it will not be duplicated.';

export function TransferForm({ wallets }: { wallets: Wallet[] }) {
  const { wallets: live } = useRealtime();
  const [fromWalletId, setFromWalletId] = useState(wallets[0]?.id ?? '');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(wallets[0]?.currency ?? 'USD');
  const [attempt, setAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Transfer | null>(null);

  const intent = `${fromWalletId}|${recipient.trim().toLowerCase()}|${amount}|${currency}|${attempt}`;
  const key = useRef<{ intent: string; value: string } | null>(null);

  const wallet = wallets.find((w) => w.id === fromWalletId);
  const balance = live[fromWalletId]?.balance ?? wallet?.balance;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const value = parseAmount(amount);
    if (value === null) {
      setError('Enter an amount above zero with at most two decimals');
      return;
    }
    if (key.current?.intent !== intent) {
      key.current = { intent, value: crypto.randomUUID() };
    }
    setError(null);
    setSent(null);
    setSending(true);
    try {
      const res = await sendWithRetries('/api/transfers', key.current.value, {
        fromWalletId,
        toWalletIdentifier: recipient.trim(),
        amount: value,
        currency,
      });
      if (res.ok) {
        setSent((await res.json()) as Transfer);
        setAttempt((n) => n + 1);
        setAmount('');
      } else {
        setError(await failureMessage(res, FAILED_REQUEST));
        if (res.status < 500 && res.status !== 429) {
          setAttempt((n) => n + 1);
        }
      }
    } catch {
      setError(FAILED_REQUEST);
    } finally {
      setSending(false);
    }
  }

  if (wallets.length === 0) {
    return <Empty>Open a wallet first.</Empty>;
  }
  return (
    <>
      <form onSubmit={onSubmit} className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>From wallet</Label>
          <Select value={fromWalletId} onValueChange={setFromWalletId}>
            <SelectTrigger aria-label="From wallet">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {wallets.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.currency}: {live[w.id]?.balance ?? w.balance}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recipient">Recipient email</Label>
          <Input
            id="recipient"
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="amount">Amount in wallet currency{wallet ? ` (${wallet.currency})` : ''}</Label>
          <Input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label>Recipient currency</Label>
          <Select value={currency} onValueChange={setCurrency}>
            <SelectTrigger aria-label="Recipient currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground">Available: {balance ?? '—'}</p>
        <Button type="submit" disabled={sending}>
          {sending ? 'Sending…' : 'Send transfer'}
        </Button>
        {error && <FormError>{error}</FormError>}
      </form>
      {sent && <SagaProgress key={sent.id} initial={sent} />}
    </>
  );
}
