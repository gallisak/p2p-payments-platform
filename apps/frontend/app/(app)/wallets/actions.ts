'use server';

import { revalidatePath } from 'next/cache';
import { isRedirectError } from 'next/dist/client/components/redirect';
import { parseAmount } from '@/lib/money';
import { authedFetch, errorText } from '@/lib/server-api';

export interface ActionResult {
  error?: string;
}

async function mutate(path: string, body: object, fallback: string): Promise<ActionResult> {
  try {
    await authedFetch(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    if (isRedirectError(err)) {
      throw err;
    }
    return { error: errorText(err, fallback) };
  }
  revalidatePath('/wallets');
  revalidatePath('/dashboard');
  return {};
}

export async function openWallet(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  return mutate('/api/wallets', { currency: form.get('currency') }, 'Could not open the wallet');
}

export async function depositMoney(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const amount = parseAmount(form.get('amount'));
  if (amount === null) {
    return { error: 'Enter an amount above zero with at most two decimals' };
  }
  const walletId = encodeURIComponent(String(form.get('walletId')));
  return mutate(`/api/wallets/${walletId}/deposit`, { amount }, 'Could not top up the wallet');
}
