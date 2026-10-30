'use client';

import { useEffect, useRef } from 'react';
import { useFormState } from 'react-dom';
import { FormError } from './form-error';
import { SubmitButton } from './submit-button';
import { ActionResult, depositMoney, openWallet } from '@/app/(app)/wallets/actions';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CURRENCIES, Wallet } from '@/lib/types';

const INITIAL: ActionResult = {};

export function OpenWalletForm() {
  const [result, action] = useFormState(openWallet, INITIAL);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Select name="currency" defaultValue={CURRENCIES[0]}>
        <SelectTrigger className="w-28" aria-label="Currency">
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
      <SubmitButton>Open wallet</SubmitButton>
      {result.error && <FormError>{result.error}</FormError>}
    </form>
  );
}

export function DepositForm({ wallets }: { wallets: Wallet[] }) {
  const [result, action] = useFormState(depositMoney, INITIAL);
  const amount = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (result !== INITIAL && !result.error && amount.current) {
      amount.current.value = '';
    }
  }, [result]);

  if (wallets.length === 0) {
    return null;
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Select name="walletId" defaultValue={wallets[0].id}>
        <SelectTrigger className="w-28" aria-label="Wallet">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {wallets.map((w) => (
            <SelectItem key={w.id} value={w.id}>
              {w.currency}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input ref={amount} name="amount" inputMode="decimal" placeholder="Amount" aria-label="Amount" className="w-32" required />
      <SubmitButton>Top up</SubmitButton>
      {result.error && <FormError>{result.error}</FormError>}
    </form>
  );
}
