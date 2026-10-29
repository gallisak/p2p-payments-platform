import { User, createTransfer, openWallet, reconciliation, registerUser, transfer, walletIn } from './client';

export interface DoubleSpendOptions {
  balance: number;
  amount: number;
  transfers: number;
}

export interface DoubleSpendResult {
  options: DoubleSpendOptions;
  expectedCompleted: number;
  expectedRecipientBalance: string;
  accepted: number;
  completed: number;
  failedByReason: Record<string, number>;
  finalBalance: string;
  finalHeld: string;
  recipientBalance: string;
  reconciliationOk: boolean;
  wallTimeMs: number;
  acceptLatencyMs: { p50: number; p95: number; max: number };
  sagaLatencyMs: { p50: number; p95: number; max: number };
  throughputPerSecond: number;
}

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
  return { p50: at(50), p95: at(95), max: sorted[sorted.length - 1] ?? 0 };
}

const POLL_CONCURRENCY = 25;
const POLL_INTERVAL_MS = 200;

async function settleAll(user: User, ids: string[], timeoutMs: number) {
  const settled = new Map<string, any>();
  const deadline = Date.now() + timeoutMs;
  while (settled.size < ids.length) {
    if (Date.now() > deadline) {
      throw new Error(`${ids.length - settled.size} transfers did not settle in ${timeoutMs} ms`);
    }
    const pending = ids.filter((id) => !settled.has(id));
    for (let i = 0; i < pending.length; i += POLL_CONCURRENCY) {
      const batch = await Promise.all(pending.slice(i, i + POLL_CONCURRENCY).map((id) => transfer(user, id)));
      for (const t of batch) {
        if (t.status === 'completed' || t.status === 'failed') settled.set(t.id, t);
      }
    }
    if (settled.size < ids.length) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
  return ids.map((id) => settled.get(id));
}

const cents = (value: number) => Math.round(value * 100);

export async function runDoubleSpend(options: DoubleSpendOptions): Promise<DoubleSpendResult> {
  const sender = await registerUser('spender');
  const recipient = await registerUser('recipient');
  const from = await openWallet(sender, 'USD', options.balance);
  await openWallet(recipient, 'USD');

  const started = Date.now();
  const created = await Promise.all(
    Array.from({ length: options.transfers }, async () => {
      const sentAt = Date.now();
      const res = await createTransfer(sender, {
        fromWalletId: from,
        toWalletIdentifier: recipient.email,
        amount: options.amount,
        currency: 'USD',
      });
      return { res, acceptMs: Date.now() - sentAt };
    }),
  );
  const accepted = created.filter((c) => c.res.status === 202);
  const results = await settleAll(sender, accepted.map((c) => c.res.body.id), 120_000);
  const wallTimeMs = Date.now() - started;

  const failedByReason: Record<string, number> = {};
  for (const t of results.filter((r) => r.status === 'failed')) {
    failedByReason[t.failureReason] = (failedByReason[t.failureReason] ?? 0) + 1;
  }
  const completed = results.filter((r) => r.status === 'completed');
  const senderWallet = await walletIn(sender, 'USD');
  const recipientWallet = await walletIn(recipient, 'USD');
  const expectedCompleted = Math.min(options.transfers, Math.floor(cents(options.balance) / cents(options.amount)));
  const expectedRecipient = expectedCompleted * cents(options.amount);
  return {
    options,
    expectedCompleted,
    expectedRecipientBalance: `${Math.floor(expectedRecipient / 100)}.${String(expectedRecipient % 100).padStart(2, '0')}`,
    accepted: accepted.length,
    completed: completed.length,
    failedByReason,
    finalBalance: senderWallet?.balance ?? 'missing',
    finalHeld: senderWallet?.held ?? 'missing',
    recipientBalance: recipientWallet?.balance ?? 'missing',
    reconciliationOk: (await reconciliation()).ok === true,
    wallTimeMs,
    acceptLatencyMs: percentiles(created.map((c) => c.acceptMs)),
    sagaLatencyMs: percentiles(
      completed.map((t) => new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime()),
    ),
    throughputPerSecond: Math.round((results.length / (wallTimeMs / 1000)) * 10) / 10,
  };
}
