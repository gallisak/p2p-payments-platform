'use server';

import { revalidatePath } from 'next/cache';
import { isRedirectError } from 'next/dist/client/components/redirect';
import { redirect } from 'next/navigation';
import { parseAmount } from '@/lib/money';
import { authedFetch, errorText } from '@/lib/server-api';
import { SplitBill } from '@/lib/types';

export interface CreateResult {
  error?: string;
}

function parseParticipants(text: string, custom: boolean) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, amount] = line.split(/[\s,;]+/);
      return custom ? { email, amount: parseAmount(amount) } : { email };
    });
}

export async function createSplitBill(_prev: CreateResult, form: FormData): Promise<CreateResult> {
  const totalAmount = parseAmount(form.get('totalAmount'));
  const split = String(form.get('split'));
  const participants = parseParticipants(String(form.get('participants') ?? ''), split === 'custom');
  if (totalAmount === null) {
    return { error: 'Enter the bill amount' };
  }
  if (participants.length === 0) {
    return { error: 'Add at least one participant' };
  }
  if (participants.some((p) => 'amount' in p && p.amount === null)) {
    return { error: 'For custom amounts, add an amount next to each email' };
  }
  let bill: SplitBill;
  try {
    bill = await authedFetch<SplitBill>('/api/split-bills', {
      method: 'POST',
      body: JSON.stringify({
        title: form.get('title'),
        currency: form.get('currency'),
        totalAmount,
        dueAt: `${form.get('dueDate')}T23:59:59.000Z`,
        split,
        includeCreator: form.get('includeCreator') === 'on',
        participants,
      }),
    });
  } catch (err) {
    if (isRedirectError(err)) {
      throw err;
    }
    return { error: errorText(err, 'Could not create the bill') };
  }
  revalidatePath('/split-bills');
  redirect(`/split-bills/${bill.id}`);
}
