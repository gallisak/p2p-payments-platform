import { LedgerPort } from '../ledger/ledger.client';
import { LedgerRejectedError, LedgerUnavailableError } from '../ledger/ledger.errors';
import { FxQuote } from '../fx/fx.service';
import { convertCents, parseMicro } from '../fx/fx';
import { formatCents, toCents } from '../common/money';
import { Transfer } from '../transfers/entities/transfer.entity';
import { FailureReason, TransferStatus } from '../transfers/transfer-status';

export type SagaStepName = 'check' | 'hold' | 'confirm' | 'capture' | 'compensate';

export const STEP_BY_STATUS: Partial<Record<TransferStatus, SagaStepName>> = {
  pending: 'check',
  checked: 'hold',
  funds_held: 'confirm',
  confirmed: 'capture',
  compensating: 'compensate',
};

export interface SagaPolicy {
  maxTransferUsdCents: bigint;
  dailyLimitUsdCents: bigint;
  blockedRecipients: ReadonlySet<string>;
  maxStepAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
}

export interface SagaPorts {
  ledger: LedgerPort;
  quote(from: string, to: string): Promise<FxQuote>;
  reserveDailyLimit(transfer: Transfer, limitCents: bigint, dailyLimitCents: bigint): Promise<boolean>;
  now(): Date;
}

export type Transition =
  | { kind: 'advance'; status: TransferStatus; patch: Partial<Transfer> }
  | { kind: 'retry'; error: string; delayMs: number }
  | { kind: 'fail'; reason: FailureReason; detail: string }
  | { kind: 'compensate'; reason: FailureReason; detail: string };

class StepFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    detail: string,
  ) {
    super(detail);
  }
}

export class TransferSaga {
  constructor(
    private readonly ports: SagaPorts,
    private readonly policy: SagaPolicy,
  ) {}

  async step(transfer: Transfer): Promise<Transition> {
    const step = STEP_BY_STATUS[transfer.status];
    if (!step) {
      throw new Error(`Transfer ${transfer.id} is already ${transfer.status}`);
    }
    if (step !== 'compensate' && this.ports.now() >= transfer.deadlineAt) {
      return this.failure(transfer, 'timed_out', 'The transfer did not finish in time');
    }
    try {
      switch (step) {
        case 'check':
          return await this.check(transfer);
        case 'hold':
          return await this.hold(transfer);
        case 'confirm':
          return await this.confirm(transfer);
        case 'capture':
          return await this.capture(transfer);
        case 'compensate':
          return await this.compensate(transfer);
      }
    } catch (err) {
      if (err instanceof StepFailure) {
        return this.failure(transfer, err.reason, err.message);
      }
      return this.retry(transfer, err);
    }
  }

  private async check(t: Transfer): Promise<Transition> {
    const source = await this.rejectedAs(
      () => this.ports.ledger.getWallet(t.fromWalletId, t.senderId),
      (status) => (status === 404 ? 'source_wallet_not_found' : 'rejected_by_ledger'),
    );
    if (source.blocked) {
      throw new StepFailure('source_wallet_blocked', 'The sender wallet is blocked');
    }
    if (this.policy.blockedRecipients.has(t.recipientEmail.toLowerCase())) {
      throw new StepFailure('recipient_not_allowed', 'Transfers to this recipient are not allowed');
    }
    const recipient = await this.rejectedAs(
      () => this.ports.ledger.resolveRecipient(t.recipientEmail, t.toCurrency),
      (status) => (status === 404 ? 'recipient_not_found' : 'rejected_by_ledger'),
    );
    if (recipient.walletId === t.fromWalletId) {
      throw new StepFailure('same_wallet', 'Cannot transfer to the same wallet');
    }
    if (recipient.blocked) {
      throw new StepFailure('recipient_blocked', 'The recipient wallet is blocked');
    }

    const amountCents = toCents(t.amount);
    const quote = await this.ports.quote(source.currency, t.toCurrency);
    const creditCents = convertCents(amountCents, parseMicro(quote.rate));
    if (creditCents <= 0n) {
      throw new StepFailure('amount_too_small', 'The amount is zero after conversion');
    }
    const usd = await this.ports.quote(source.currency, 'USD');
    const limitCents = convertCents(amountCents, parseMicro(usd.rate));
    if (limitCents > this.policy.maxTransferUsdCents) {
      throw new StepFailure('limit_exceeded', 'Per-transfer limit exceeded');
    }
    if (!(await this.ports.reserveDailyLimit(t, limitCents, this.policy.dailyLimitUsdCents))) {
      throw new StepFailure('daily_limit_exceeded', 'Daily transfer limit exceeded');
    }

    return this.advance('checked', {
      fromCurrency: source.currency,
      recipientId: recipient.ownerId,
      toWalletId: recipient.walletId,
      creditAmount: formatCents(creditCents),
      rate: quote.rate,
      rateExpiresAt: quote.expiresAt,
      limitCents: limitCents.toString(),
    });
  }

  private async hold(t: Transfer): Promise<Transition> {
    try {
      await this.ports.ledger.placeHold({
        holdId: t.id,
        walletId: t.fromWalletId,
        ownerId: t.senderId,
        amount: t.amount,
      });
    } catch (err) {
      if (err instanceof LedgerRejectedError) {
        return { kind: 'fail', reason: holdRejection(err.status), detail: err.message };
      }
      throw err;
    }
    return this.advance('funds_held', {});
  }

  private async confirm(t: Transfer): Promise<Transition> {
    this.assertRateFresh(t);
    const recipient = await this.rejectedAs(
      () => this.ports.ledger.getWallet(required(t.toWalletId), required(t.recipientId)),
      (status) => (status === 404 ? 'recipient_not_found' : 'rejected_by_ledger'),
    );
    if (recipient.blocked) {
      throw new StepFailure('recipient_blocked', 'The recipient wallet is blocked');
    }
    return this.advance('confirmed', {});
  }

  private async capture(t: Transfer): Promise<Transition> {
    this.assertRateFresh(t);
    await this.rejectedAs(
      () =>
        this.ports.ledger.captureHold(t.id, {
          toWalletId: required(t.toWalletId),
          amount: required(t.creditAmount),
          currency: t.toCurrency,
        }),
      (status) => (status === 423 ? 'wallet_blocked' : 'rejected_by_ledger'),
    );
    return this.advance('completed', { completedAt: this.ports.now() });
  }

  private async compensate(t: Transfer): Promise<Transition> {
    try {
      await this.ports.ledger.releaseHold(t.id, t.fromWalletId);
    } catch (err) {
      if (err instanceof LedgerRejectedError && err.status === 409) {
        return this.advance('completed', {
          completedAt: this.ports.now(),
          failureReason: null,
          failureDetail: null,
        });
      }
      if (err instanceof LedgerRejectedError && err.status === 404) {
        return this.advance('failed', { completedAt: this.ports.now() });
      }
      return this.retry(t, err);
    }
    return this.advance('failed', { completedAt: this.ports.now() });
  }

  private assertRateFresh(t: Transfer): void {
    if (!t.rateExpiresAt || this.ports.now() >= t.rateExpiresAt) {
      throw new StepFailure('rate_expired', 'The exchange rate has expired');
    }
  }

  private async rejectedAs<T>(
    call: () => Promise<T>,
    reason: (status: number) => FailureReason,
  ): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof LedgerRejectedError) {
        throw new StepFailure(reason(err.status), err.message);
      }
      throw err;
    }
  }

  private advance(status: TransferStatus, patch: Partial<Transfer>): Transition {
    return { kind: 'advance', status, patch };
  }

  private failure(t: Transfer, reason: FailureReason, detail: string): Transition {
    return t.status === 'pending'
      ? { kind: 'fail', reason, detail }
      : { kind: 'compensate', reason, detail };
  }

  private retry(t: Transfer, err: unknown): Transition {
    const error = err instanceof Error ? err.message : String(err);
    const attempt = t.attempts + 1;
    if (t.status !== 'compensating' && attempt >= this.policy.maxStepAttempts) {
      return this.failure(t, 'ledger_unavailable', `The step failed after ${attempt} attempts: ${error}`);
    }
    const backoff = Math.min(
      this.policy.retryBaseMs * 2 ** Math.min(t.attempts, 20),
      this.policy.retryMaxMs,
    );
    const waitForBreaker = err instanceof LedgerUnavailableError ? err.retryInMs : 0;
    return { kind: 'retry', error, delayMs: Math.max(backoff, waitForBreaker) };
  }
}

function holdRejection(status: number): FailureReason {
  switch (status) {
    case 400:
      return 'insufficient_funds';
    case 404:
      return 'source_wallet_not_found';
    case 423:
      return 'source_wallet_blocked';
    default:
      return 'rejected_by_ledger';
  }
}

function required<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Saga state is incomplete');
  }
  return value;
}
