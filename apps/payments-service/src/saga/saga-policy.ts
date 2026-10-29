import { SagaPolicy } from './transfer-saga';
import { numberEnv } from '../common/env';
import { toCents } from '../common/money';

export interface SagaRuntimeOptions {
  timeoutMs: number;
  leaseMs: number;
  pollMs: number;
  batchSize: number;
}

export function sagaPolicyFromEnv(): SagaPolicy {
  return {
    maxTransferUsdCents: toCents(numberEnv('TRANSFER_MAX_AMOUNT_USD', 10_000)),
    dailyLimitUsdCents: toCents(numberEnv('TRANSFER_DAILY_LIMIT_USD', 50_000)),
    blockedRecipients: new Set(
      (process.env.TRANSFER_BLOCKED_RECIPIENTS ?? '')
        .split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
    maxStepAttempts: Math.max(1, numberEnv('SAGA_MAX_STEP_ATTEMPTS', 5)),
    retryBaseMs: numberEnv('SAGA_RETRY_BASE_MS', 500),
    retryMaxMs: numberEnv('SAGA_RETRY_MAX_MS', 30_000),
  };
}

export function sagaRuntimeFromEnv(): SagaRuntimeOptions {
  const options = {
    timeoutMs: numberEnv('SAGA_TIMEOUT_MS', 120_000),
    leaseMs: numberEnv('SAGA_LEASE_MS', 30_000),
    pollMs: numberEnv('SAGA_POLL_MS', 200),
    batchSize: Math.max(1, numberEnv('SAGA_BATCH_SIZE', 10)),
  };
  const ledgerTimeoutMs = numberEnv('LEDGER_TIMEOUT_MS', 3_000);
  if (options.leaseMs < ledgerTimeoutMs * 4) {
    throw new Error('SAGA_LEASE_MS must be at least 4 × LEDGER_TIMEOUT_MS');
  }
  return options;
}
