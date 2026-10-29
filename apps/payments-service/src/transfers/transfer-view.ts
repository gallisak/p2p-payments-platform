import { Transfer } from './entities/transfer.entity';
import { SagaStep } from './entities/saga-step.entity';

export function transferView(t: Transfer) {
  return {
    id: t.id,
    status: t.status,
    fromWalletId: t.fromWalletId,
    fromCurrency: t.fromCurrency,
    amount: t.amount,
    recipientEmail: t.recipientEmail,
    toWalletId: t.toWalletId,
    toCurrency: t.toCurrency,
    creditAmount: t.creditAmount,
    rate: t.rate,
    failureReason: t.failureReason,
    failureDetail: t.failureDetail,
    awaitingRetry: t.awaitingRetry,
    lastError: t.lastError,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
  };
}

export function stepView(s: SagaStep) {
  return {
    step: s.step,
    outcome: s.outcome,
    startedAt: s.startedAt.toISOString(),
    durationMs: s.durationMs,
    error: s.error,
  };
}
