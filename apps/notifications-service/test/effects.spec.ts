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

const CREATOR = '66666666-6666-4666-8666-666666666666';
const ALICE = '77777777-7777-4777-8777-777777777777';
const BOB = '88888888-8888-4888-8888-888888888888';

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

    it('does not mistake a split bill event for a transfer', () => {
      const { effects } = payments({
        type: 'SplitBillSettled',
        payload: { status: 'settled', bill: { title: 'Dinner', currency: 'USD', totalAmount: '90.00', creatorId: CREATOR } },
      });

      expect(effects.transfer).toBeNull();
      expect(effects.activities).toEqual([
        expect.objectContaining({ userId: CREATOR, type: 'split_bill_settled', data: expect.objectContaining({ title: 'Dinner', totalAmount: '90.00' }) }),
      ]);
    });

    it('ignores payments events that do not describe a transfer', () => {
      const { effects } = payments({ type: 'SomethingElse', payload: { status: undefined } });

      expect(effects).toEqual({ wallet: null, transfer: null, activities: [] });
    });
  });

  describe('split bill events', () => {
    const bill = {
      id: 'b',
      title: 'Dinner',
      currency: 'USD',
      totalAmount: '90.00',
      dueAt: '2026-11-05T00:00:00.000Z',
      creatorId: CREATOR,
      creatorEmail: 'host@example.com',
      status: 'pending',
    };
    const share = (participantId: string, amount: string) => ({
      id: randomUUID(),
      participantId,
      participantEmail: `${participantId.slice(0, 4)}@example.com`,
      amount,
      reminderCount: 1,
    });

    it('tells every participant they were added to a bill, with their own share', () => {
      const shares = [share(ALICE, '45.00'), share(BOB, '45.00')];
      const { raw, effects } = payments({ type: 'SplitBillCreated', payload: { bill: { ...bill, shares } } });

      expect(effects.activities).toEqual([
        expect.objectContaining({ userId: ALICE, type: 'split_bill_created', data: expect.objectContaining({ billId: raw.streamId, amount: '45.00', creatorEmail: 'host@example.com' }) }),
        expect.objectContaining({ userId: BOB, type: 'split_bill_created', data: expect.objectContaining({ shareId: shares[1].id }) }),
      ]);
    });

    it('tells the creator a share was paid and the participant that their share is overdue', () => {
      const paid = payments({ type: 'SplitSharePaid', payload: { bill: { ...bill, status: 'partially_paid' }, share: share(ALICE, '45.00') } });
      const overdue = payments({ type: 'SplitShareOverdue', payload: { bill, share: share(BOB, '45.00') } });

      expect(paid.effects.activities).toEqual([
        expect.objectContaining({ userId: CREATOR, type: 'split_share_paid', data: expect.objectContaining({ amount: '45.00', billStatus: 'partially_paid' }) }),
      ]);
      expect(overdue.effects.activities).toEqual([
        expect.objectContaining({ userId: BOB, type: 'split_share_overdue', data: expect.objectContaining({ reminderCount: 1, dueAt: bill.dueAt }) }),
      ]);
    });

    it.each([
      ['without a bill', { share: share(ALICE, '1.00') }],
      ['with a malformed participant', { bill: { ...bill, shares: [{ ...share(ALICE, '1.00'), participantId: 'alice' }] } }],
      ['without shares', { bill }],
    ])('rejects a malformed split event %s', (_name, payload) => {
      expect(() => payments({ type: 'SplitBillCreated', payload })).toThrow(InvalidEnvelopeError);
    });

    it('ignores split event types it does not know yet', () => {
      expect(payments({ type: 'SplitBillRenamed', payload: { bill } }).effects).toEqual({ wallet: null, transfer: null, activities: [] });
    });
  });
});
