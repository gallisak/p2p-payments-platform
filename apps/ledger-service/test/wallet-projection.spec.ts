import { StoredEvent } from '../src/ledger/ledger-events';
import { formatCents } from '../src/ledger/money';
import {
  EMPTY_WALLET,
  WalletState,
  applyEvent,
  foldWallet,
} from '../src/ledger/wallet-projection';

const WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';

const opened: StoredEvent = {
  type: 'WalletOpened',
  schemaVersion: 1,
  streamVersion: 1,
  payload: { ownerId: 'owner', currency: 'USD' },
};

function event(
  type: StoredEvent['type'],
  streamVersion: number,
  amount: string,
): StoredEvent {
  const base = { operationId: `op-${streamVersion}`, amount, currency: 'USD' };
  const payloads: Record<string, unknown> = {
    MoneyDeposited: { ...base, postings: [] },
    MoneyWithdrawn: { ...base, postings: [] },
    HoldPlaced: { holdId: `h-${amount}`, amount, currency: 'USD' },
    HoldReleased: { holdId: `h-${amount}`, amount, currency: 'USD' },
    TransferCompleted: {
      ...base,
      holdId: `h-${amount}`,
      toWalletId: OTHER,
      creditAmount: amount,
      creditCurrency: 'USD',
      postings: [],
    },
    TransferReceived: { ...base, holdId: 'h', fromWalletId: WALLET },
  };
  return {
    type,
    schemaVersion: type.startsWith('Money') ? 2 : 1,
    streamVersion,
    payload: payloads[type] as StoredEvent['payload'],
  };
}

const show = (state: WalletState) => ({
  balance: formatCents(state.balance),
  held: formatCents(state.held),
});

describe('wallet projection', () => {
  it('starts empty when the wallet is opened', () => {
    expect(show(foldWallet([opened]))).toEqual({ balance: '0.00', held: '0.00' });
  });

  it('rebuilds balance from deposits and withdrawals', () => {
    const events = [
      opened,
      event('MoneyDeposited', 2, '100.00'),
      event('MoneyWithdrawn', 3, '30.25'),
      event('MoneyDeposited', 4, '0.29'),
    ];
    expect(show(foldWallet(events))).toEqual({ balance: '70.04', held: '0.00' });
  });

  it('a hold reserves funds without changing the balance', () => {
    const events = [
      opened,
      event('MoneyDeposited', 2, '100.00'),
      event('HoldPlaced', 3, '40.00'),
    ];
    expect(show(foldWallet(events))).toEqual({ balance: '100.00', held: '40.00' });
  });

  it('releasing a hold returns the reserved funds', () => {
    const events = [
      opened,
      event('MoneyDeposited', 2, '100.00'),
      event('HoldPlaced', 3, '40.00'),
      event('HoldReleased', 4, '40.00'),
    ];
    expect(show(foldWallet(events))).toEqual({ balance: '100.00', held: '0.00' });
  });

  it('completing a transfer spends the held funds', () => {
    const events = [
      opened,
      event('MoneyDeposited', 2, '100.00'),
      event('HoldPlaced', 3, '40.00'),
      event('TransferCompleted', 4, '40.00'),
    ];
    expect(show(foldWallet(events))).toEqual({ balance: '60.00', held: '0.00' });
  });

  it('receiving a transfer credits the balance', () => {
    const events = [opened, event('TransferReceived', 2, '12.34')];
    expect(show(foldWallet(events))).toEqual({ balance: '12.34', held: '0.00' });
  });

  it('applies events in stream order regardless of input order', () => {
    const events = [
      event('MoneyWithdrawn', 3, '40.00'),
      opened,
      event('MoneyDeposited', 2, '50.00'),
    ];
    expect(show(foldWallet(events)).balance).toBe('10.00');
  });

  it('upcasts v1 deposits from the log before applying them', () => {
    const v1Deposit: StoredEvent = {
      type: 'MoneyDeposited',
      schemaVersion: 1,
      streamVersion: 2,
      payload: {
        operationId: 'op',
        amount: '15.00',
        currency: 'USD',
        postings: [{ accountId: WALLET, amount: '15.00' }],
      } as unknown as StoredEvent['payload'],
    };
    expect(show(foldWallet([opened, v1Deposit])).balance).toBe('15.00');
  });

  it('matches the incrementally maintained projection after every event', () => {
    const events: StoredEvent[] = [opened];
    let live = EMPTY_WALLET;
    const cycle: [StoredEvent['type'], string][] = [
      ['MoneyDeposited', '20.00'],
      ['HoldPlaced', '5.00'],
      ['TransferCompleted', '5.00'],
      ['MoneyWithdrawn', '1.10'],
      ['HoldPlaced', '2.00'],
      ['HoldReleased', '2.00'],
      ['TransferReceived', '0.35'],
    ];
    for (let v = 2; v <= 50; v++) {
      const [type, amount] = cycle[(v - 2) % cycle.length];
      const next = event(type, v, amount);
      events.push(next);
      live = applyEvent(live, next);
      expect(foldWallet(events)).toEqual(live);
    }
    expect(live.held).toBe(0n);
  });
});
