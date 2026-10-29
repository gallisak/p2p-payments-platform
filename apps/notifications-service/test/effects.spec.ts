import { randomUUID } from 'crypto';
import { effectsOf } from '../src/events/effects';
import { InvalidEnvelopeError, parseEnvelope } from '../src/events/envelope';
import { depositPayload, ledgerEnvelope, paymentsEnvelope } from './support/envelopes';

const ledger = (input: Parameters<typeof ledgerEnvelope>[0]) => {
  const raw = ledgerEnvelope(input);
  return { raw, effects: effectsOf('ledger', parseEnvelope('ledger', JSON.stringify(raw))) };
};
const payments = (input: Parameters<typeof paymentsEnvelope>[0]) => {
  const raw = paymentsEnvelope(input);
  return { raw, effects: effectsOf('payments', parseEnvelope('payments', JSON.stringify(raw))) };
};

describe('effectsOf', () => {
  describe('ledger events', () => {
    it('updates the wallet snapshot from every event', () => {
      const { raw, effects } = ledger({
        type: 'HoldPlaced',
        streamVersion: 4,
        wallet: { balance: '100.00', held: '40.00' },
        payload: { holdId: randomUUID(), amount: '40.00', currency: 'USD' },
      });

      expect(effects.wallet).toEqual({
        walletId: raw.streamId,
        ownerId: raw.ownerId,
        currency: 'USD',
        balance: '100.00',
        held: '40.00',
        blocked: false,
        streamVersion: 4,
        occurredAt: new Date(raw.occurredAt),
      });
      expect(effects.activities).toEqual([]);
      expect(effects.transfer).toBeNull();
    });

    it.each([
      ['MoneyDeposited', 'deposit'],
      ['MoneyWithdrawn', 'withdrawal'],
    ])('records %s as a %s for the wallet owner', (type, activity) => {
      const payload = depositPayload('25.00', 'EUR');
      const { raw, effects } = ledger({ type, payload });

      expect(effects.activities).toEqual([
        {
          userId: raw.ownerId,
          type: activity,
          occurredAt: new Date(raw.occurredAt),
          data: { walletId: raw.streamId, operationId: payload.operationId, amount: '25.00', currency: 'EUR' },
        },
      ]);
    });

    it('records both sides of a transfer for their own owners', () => {
      const operationId = randomUUID();
      const sent = ledger({
        type: 'TransferCompleted',
        payload: {
          operationId,
          holdId: randomUUID(),
          amount: '50.00',
          currency: 'USD',
          toWalletId: randomUUID(),
          creditAmount: '46.00',
          creditCurrency: 'EUR',
          postings: [],
        },
      });
      const received = ledger({
        type: 'TransferReceived',
        payload: { operationId, holdId: randomUUID(), fromWalletId: sent.raw.streamId, amount: '46.00', currency: 'EUR' },
      });

      expect(sent.effects.activities).toEqual([
        expect.objectContaining({
          userId: sent.raw.ownerId,
          type: 'transfer_sent',
          data: expect.objectContaining({ amount: '50.00', creditAmount: '46.00', creditCurrency: 'EUR' }),
        }),
      ]);
      expect(received.effects.activities).toEqual([
        expect.objectContaining({
          userId: received.raw.ownerId,
          type: 'transfer_received',
          data: expect.objectContaining({ fromWalletId: sent.raw.streamId, amount: '46.00' }),
        }),
      ]);
    });

    it('records blocking and unblocking of a wallet without the admin’s internal reason', () => {
      const blocked = ledger({ type: 'WalletBlocked', payload: { reason: 'fraud check' } });
      expect(blocked.effects.activities).toEqual([
        expect.objectContaining({ type: 'wallet_blocked', data: { walletId: blocked.raw.streamId } }),
      ]);
      expect(ledger({ type: 'WalletUnblocked' }).effects.activities).toEqual([
        expect.objectContaining({ type: 'wallet_unblocked' }),
      ]);
    });

    it('keeps the wallet snapshot of an event type it does not know yet', () => {
      const { effects } = ledger({ type: 'WalletRenamed', payload: { name: 'x' } });

      expect(effects.wallet).not.toBeNull();
      expect(effects.activities).toEqual([]);
    });

    it.each([
      ['MoneyDeposited', { operationId: randomUUID(), currency: 'USD' }],
      ['TransferCompleted', { operationId: randomUUID(), amount: '1.00', currency: 'USD' }],
      ['TransferReceived', { operationId: randomUUID(), amount: '1.00' }],
    ])('rejects a %s event without the fields the feed needs', (type, payload) => {
      expect(() => ledger({ type, payload })).toThrow(InvalidEnvelopeError);
    });
  });

  describe('payments events', () => {
    it('updates the transfer snapshot of the sender', () => {
      const { raw, effects } = payments({ type: 'TransferStepChanged', streamVersion: 3, payload: { status: 'funds_held' } });

      expect(effects.transfer).toMatchObject({
        transferId: raw.streamId,
        ownerId: raw.ownerId,
        status: 'funds_held',
        streamVersion: 3,
        view: raw.payload,
      });
      expect(effects.wallet).toBeNull();
      expect(effects.activities).toEqual([]);
    });

    it('records a failed transfer in the sender’s feed', () => {
      const { raw, effects } = payments({
        type: 'TransferFailed',
        payload: { status: 'failed', failureReason: 'insufficient_funds', fromCurrency: 'USD', toCurrency: 'EUR', recipientEmail: 'b@x.io' },
      });

      expect(effects.activities).toEqual([
        {
          userId: raw.ownerId,
          type: 'transfer_failed',
          occurredAt: new Date(raw.occurredAt),
          data: {
            transferId: raw.streamId,
            fromWalletId: null,
            amount: '10.00',
            currency: 'USD',
            toCurrency: 'EUR',
            recipientEmail: 'b@x.io',
            failureReason: 'insufficient_funds',
          },
        },
      ]);
    });

    it('does not duplicate a completed transfer that the ledger already reports', () => {
      expect(payments({ type: 'TransferCompleted', payload: { status: 'completed' } }).effects.activities).toEqual([]);
    });

    it('ignores payments events that do not describe a transfer', () => {
      const { effects } = payments({ type: 'SomethingElse', payload: { status: undefined } });

      expect(effects).toEqual({ wallet: null, transfer: null, activities: [] });
    });
  });
});
