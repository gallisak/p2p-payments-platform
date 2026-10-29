import { TransferSaga, SagaPolicy, SagaPorts } from '../src/saga/transfer-saga';
import { LedgerPort, LedgerWallet } from '../src/ledger/ledger.client';
import { LedgerRejectedError, LedgerUnavailableError } from '../src/ledger/ledger.errors';
import { Transfer } from '../src/transfers/entities/transfer.entity';
import { TransferStatus } from '../src/transfers/transfer-status';

const NOW = new Date('2026-10-29T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';
const FROM_WALLET = '33333333-3333-4333-8333-333333333333';
const TO_WALLET = '44444444-4444-4444-8444-444444444444';

const policy: SagaPolicy = {
  maxTransferUsdCents: 1_000_000n,
  dailyLimitUsdCents: 5_000_000n,
  blockedRecipients: new Set(['blocked@example.com']),
  maxStepAttempts: 3,
  retryBaseMs: 100,
  retryMaxMs: 1_000,
};

const rejected = (status: number, message = `rejected ${status}`) =>
  new LedgerRejectedError(status, message);
const unavailable = (retryInMs = 0) => new LedgerUnavailableError('ledger down', retryInMs);

function transfer(status: TransferStatus, overrides: Partial<Transfer> = {}): Transfer {
  return Object.assign(new Transfer(), {
    id: '55555555-5555-4555-8555-555555555555',
    senderId: SENDER,
    fromWalletId: FROM_WALLET,
    recipientEmail: 'bob@example.com',
    amount: '100.00',
    toCurrency: 'EUR',
    fromCurrency: status === 'pending' ? null : 'USD',
    recipientId: status === 'pending' ? null : RECIPIENT,
    toWalletId: status === 'pending' ? null : TO_WALLET,
    creditAmount: status === 'pending' ? null : '92.00',
    rate: status === 'pending' ? null : '0.920000',
    rateExpiresAt: status === 'pending' ? null : later(60_000),
    status,
    attempts: 0,
    awaitingRetry: false,
    deadlineAt: later(120_000),
    createdAt: NOW,
    ...overrides,
  });
}

const wallet = (overrides: Partial<LedgerWallet> = {}): LedgerWallet => ({
  walletId: FROM_WALLET,
  ownerId: SENDER,
  currency: 'USD',
  blocked: false,
  ...overrides,
});

function setup(ledgerOverrides: Partial<Record<keyof LedgerPort, jest.Mock>> = {}, now = NOW) {
  const hold = { id: 'h', walletId: FROM_WALLET, amount: '100.00', currency: 'USD', status: 'placed' };
  const ledger = {
    getWallet: jest.fn(async (walletId: string) =>
      walletId === FROM_WALLET
        ? wallet()
        : wallet({ walletId: TO_WALLET, ownerId: RECIPIENT, currency: 'EUR' }),
    ),
    resolveRecipient: jest.fn(async () =>
      wallet({ walletId: TO_WALLET, ownerId: RECIPIENT, currency: 'EUR' }),
    ),
    placeHold: jest.fn(async () => hold),
    releaseHold: jest.fn(async () => ({ ...hold, status: 'released' })),
    captureHold: jest.fn(async () => ({ ...hold, status: 'captured' })),
    ...ledgerOverrides,
  };
  const ports: SagaPorts = {
    ledger,
    quote: jest.fn(async (from: string, to: string) => ({
      from,
      to,
      rate: from === to ? '1.000000' : to === 'EUR' ? '0.920000' : '1.000000',
      expiresAt: later(60_000),
    })),
    reserveDailyLimit: jest.fn(async () => true),
    now: () => now,
  };
  return { saga: new TransferSaga(ports, policy), ledger, ports };
}

describe('TransferSaga', () => {
  describe('check step', () => {
    it('resolves the recipient, quotes the rate and reserves the daily limit', async () => {
      const { saga, ports } = setup();

      const result = await saga.step(transfer('pending'));

      expect(result).toEqual({
        kind: 'advance',
        status: 'checked',
        patch: {
          fromCurrency: 'USD',
          recipientId: RECIPIENT,
          toWalletId: TO_WALLET,
          creditAmount: '92.00',
          rate: '0.920000',
          rateExpiresAt: later(60_000),
          limitCents: '10000',
        },
      });
      expect(ports.reserveDailyLimit).toHaveBeenCalledWith(expect.anything(), 10_000n, 5_000_000n);
    });

    it.each([
      ['the source wallet is not the sender’s', { getWallet: jest.fn(async () => { throw rejected(404); }) }, 'source_wallet_not_found'],
      ['the source wallet is blocked', { getWallet: jest.fn(async () => wallet({ blocked: true })) }, 'source_wallet_blocked'],
      ['the recipient does not exist', { resolveRecipient: jest.fn(async () => { throw rejected(404); }) }, 'recipient_not_found'],
      ['the recipient is blocked', { resolveRecipient: jest.fn(async () => wallet({ walletId: TO_WALLET, blocked: true })) }, 'recipient_blocked'],
      ['the recipient wallet is the source wallet', { resolveRecipient: jest.fn(async () => wallet()) }, 'same_wallet'],
    ])('fails without compensation when %s', async (_case, overrides, reason) => {
      const { saga, ledger } = setup(overrides);

      const result = await saga.step(transfer('pending'));

      expect(result).toMatchObject({ kind: 'fail', reason });
      expect(ledger.placeHold).not.toHaveBeenCalled();
      expect(ledger.releaseHold).not.toHaveBeenCalled();
    });

    it('refuses a recipient on the deny list before touching their wallet', async () => {
      const { saga, ledger } = setup();

      const result = await saga.step(transfer('pending', { recipientEmail: 'Blocked@Example.com' }));

      expect(result).toMatchObject({ kind: 'fail', reason: 'recipient_not_allowed' });
      expect(ledger.resolveRecipient).not.toHaveBeenCalled();
    });

    it('refuses a transfer above the per-transfer limit', async () => {
      const { saga, ports } = setup();

      const result = await saga.step(transfer('pending', { amount: '10000.01' }));

      expect(result).toMatchObject({ kind: 'fail', reason: 'limit_exceeded' });
      expect(ports.reserveDailyLimit).not.toHaveBeenCalled();
    });

    it('refuses a transfer above the daily limit', async () => {
      const { saga, ports } = setup();
      (ports.reserveDailyLimit as jest.Mock).mockResolvedValue(false);

      expect(await saga.step(transfer('pending'))).toMatchObject({
        kind: 'fail',
        reason: 'daily_limit_exceeded',
      });
    });

    it('refuses an amount that converts to nothing', async () => {
      const { saga, ports } = setup();
      (ports.quote as jest.Mock).mockResolvedValue({ rate: '0.010000', expiresAt: later(1) });

      expect(await saga.step(transfer('pending', { amount: '0.01' }))).toMatchObject({
        kind: 'fail',
        reason: 'amount_too_small',
      });
    });
  });

  describe('hold step', () => {
    it('reserves the amount under the transfer id', async () => {
      const { saga, ledger } = setup();
      const t = transfer('checked');

      expect(await saga.step(t)).toEqual({ kind: 'advance', status: 'funds_held', patch: {} });
      expect(ledger.placeHold).toHaveBeenCalledWith({
        holdId: t.id,
        walletId: FROM_WALLET,
        ownerId: SENDER,
        amount: '100.00',
      });
    });

    it.each([
      [400, 'insufficient_funds'],
      [404, 'source_wallet_not_found'],
      [423, 'source_wallet_blocked'],
      [409, 'rejected_by_ledger'],
    ])('fails without compensation when the ledger refuses the hold with %i', async (status, reason) => {
      const { saga, ledger } = setup({ placeHold: jest.fn(async () => { throw rejected(status); }) });

      expect(await saga.step(transfer('checked'))).toMatchObject({ kind: 'fail', reason });
      expect(ledger.releaseHold).not.toHaveBeenCalled();
    });

    it('compensates once retries are exhausted because the hold may have been placed', async () => {
      const { saga } = setup({ placeHold: jest.fn(async () => { throw unavailable(); }) });

      expect(await saga.step(transfer('checked', { attempts: 2 }))).toMatchObject({
        kind: 'compensate',
        reason: 'ledger_unavailable',
      });
    });
  });

  describe('confirm step', () => {
    it('confirms while the rate is fresh and the recipient is active', async () => {
      const { saga, ledger } = setup();

      expect(await saga.step(transfer('funds_held'))).toEqual({
        kind: 'advance',
        status: 'confirmed',
        patch: {},
      });
      expect(ledger.getWallet).toHaveBeenCalledWith(TO_WALLET, RECIPIENT);
    });

    it('compensates when the rate has expired', async () => {
      const { saga, ledger } = setup();

      const result = await saga.step(transfer('funds_held', { rateExpiresAt: NOW }));

      expect(result).toMatchObject({ kind: 'compensate', reason: 'rate_expired' });
      expect(ledger.getWallet).not.toHaveBeenCalled();
    });

    it('compensates when the recipient was blocked after the funds were held', async () => {
      const { saga } = setup({
        getWallet: jest.fn(async () => wallet({ walletId: TO_WALLET, blocked: true })),
      });

      expect(await saga.step(transfer('funds_held'))).toMatchObject({
        kind: 'compensate',
        reason: 'recipient_blocked',
      });
    });
  });

  describe('capture step', () => {
    it('captures the hold into the recipient wallet', async () => {
      const { saga, ledger } = setup();
      const t = transfer('confirmed');

      expect(await saga.step(t)).toEqual({
        kind: 'advance',
        status: 'completed',
        patch: { completedAt: NOW },
      });
      expect(ledger.captureHold).toHaveBeenCalledWith(t.id, {
        toWalletId: TO_WALLET,
        amount: '92.00',
        currency: 'EUR',
      });
    });

    it('compensates instead of capturing at a rate that expired while the capture was retried', async () => {
      const { saga, ledger } = setup();

      const result = await saga.step(transfer('confirmed', { rateExpiresAt: NOW, attempts: 2 }));

      expect(result).toMatchObject({ kind: 'compensate', reason: 'rate_expired' });
      expect(ledger.captureHold).not.toHaveBeenCalled();
    });

    it.each([
      [423, 'wallet_blocked'],
      [404, 'rejected_by_ledger'],
      [409, 'rejected_by_ledger'],
    ])('compensates when the ledger refuses the capture with %i', async (status, reason) => {
      const { saga } = setup({ captureHold: jest.fn(async () => { throw rejected(status); }) });

      expect(await saga.step(transfer('confirmed'))).toMatchObject({ kind: 'compensate', reason });
    });
  });

  describe('compensation', () => {
    it('releases the hold of its own wallet and fails the transfer', async () => {
      const { saga, ledger } = setup();
      const t = transfer('compensating', { failureReason: 'recipient_blocked' });

      expect(await saga.step(t)).toEqual({
        kind: 'advance',
        status: 'failed',
        patch: { completedAt: NOW },
      });
      expect(ledger.releaseHold).toHaveBeenCalledWith(t.id, FROM_WALLET);
    });

    it('completes the transfer when the ledger reports the hold as already captured', async () => {
      const { saga } = setup({ releaseHold: jest.fn(async () => { throw rejected(409); }) });

      expect(await saga.step(transfer('compensating'))).toEqual({
        kind: 'advance',
        status: 'completed',
        patch: { completedAt: NOW, failureReason: null, failureDetail: null },
      });
    });

    it('fails the transfer when there is nothing to release', async () => {
      const { saga } = setup({ releaseHold: jest.fn(async () => { throw rejected(404); }) });

      expect(await saga.step(transfer('compensating'))).toMatchObject({
        kind: 'advance',
        status: 'failed',
      });
    });

    it('keeps retrying with capped backoff and never gives up on releasing funds', async () => {
      const { saga } = setup({ releaseHold: jest.fn(async () => { throw unavailable(); }) });

      expect(await saga.step(transfer('compensating', { attempts: 50 }))).toEqual({
        kind: 'retry',
        error: 'ledger down',
        delayMs: 1_000,
      });
    });

    it('runs even after the saga deadline', async () => {
      const { saga, ledger } = setup({}, later(10 * 60_000));

      expect(await saga.step(transfer('compensating'))).toMatchObject({ status: 'failed' });
      expect(ledger.releaseHold).toHaveBeenCalled();
    });
  });

  describe('transient failures and timeouts', () => {
    it('retries with exponential backoff', async () => {
      const { saga } = setup({ getWallet: jest.fn(async () => { throw unavailable(); }) });

      expect(await saga.step(transfer('pending'))).toMatchObject({ kind: 'retry', delayMs: 100 });
      expect(await saga.step(transfer('pending', { attempts: 1 }))).toMatchObject({
        kind: 'retry',
        delayMs: 200,
      });
    });

    it('waits at least until the circuit breaker lets calls through again', async () => {
      const { saga } = setup({ placeHold: jest.fn(async () => { throw unavailable(4_000); }) });

      expect(await saga.step(transfer('checked'))).toMatchObject({ kind: 'retry', delayMs: 4_000 });
    });

    it('fails a transfer that never got past the check once retries are exhausted', async () => {
      const { saga } = setup({ getWallet: jest.fn(async () => { throw unavailable(); }) });

      expect(await saga.step(transfer('pending', { attempts: 2 }))).toMatchObject({
        kind: 'fail',
        reason: 'ledger_unavailable',
      });
    });

    it.each(['checked', 'funds_held', 'confirmed'] as const)(
      'compensates a %s transfer once retries are exhausted',
      async (status) => {
        const failing = jest.fn(async () => { throw unavailable(); });
        const { saga } = setup({ placeHold: failing, getWallet: failing, captureHold: failing });

        expect(await saga.step(transfer(status, { attempts: 2 }))).toMatchObject({
          kind: 'compensate',
          reason: 'ledger_unavailable',
        });
      },
    );

    it('fails a pending transfer past its deadline without calling the ledger', async () => {
      const { saga, ledger } = setup({}, later(120_000));

      expect(await saga.step(transfer('pending'))).toMatchObject({ kind: 'fail', reason: 'timed_out' });
      expect(ledger.getWallet).not.toHaveBeenCalled();
    });

    it.each(['checked', 'funds_held', 'confirmed'] as const)(
      'compensates a %s transfer past its deadline',
      async (status) => {
        const { saga, ledger } = setup({}, later(120_000));

        expect(await saga.step(transfer(status))).toMatchObject({
          kind: 'compensate',
          reason: 'timed_out',
        });
        expect(ledger.placeHold).not.toHaveBeenCalled();
        expect(ledger.captureHold).not.toHaveBeenCalled();
      },
    );

    it('refuses to step a finished transfer', async () => {
      const { saga } = setup();

      await expect(saga.step(transfer('completed'))).rejects.toThrow('already completed');
      await expect(saga.step(transfer('failed'))).rejects.toThrow('already failed');
    });
  });
});
