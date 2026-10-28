import {
  MoneyMovedPayload,
  StoredEvent,
  depositPostings,
  withdrawalPostings,
} from '../src/ledger/ledger-events';
import { formatCents, toCents } from '../src/ledger/money';
import { applyToBalance, foldBalance } from '../src/ledger/wallet-projection';

const WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';

function moved(
  type: 'MoneyDeposited' | 'MoneyWithdrawn',
  streamVersion: number,
  amount: string,
): StoredEvent {
  const cents = toCents(amount);
  const payload: MoneyMovedPayload = {
    operationId: `op-${streamVersion}`,
    amount,
    currency: 'USD',
    postings:
      type === 'MoneyDeposited'
        ? depositPostings(WALLET, 'USD', cents)
        : withdrawalPostings(WALLET, 'USD', cents),
  };
  return { type, schemaVersion: 1, streamVersion, payload };
}

const opened: StoredEvent = {
  type: 'WalletOpened',
  schemaVersion: 1,
  streamVersion: 1,
  payload: { ownerId: 'owner', currency: 'USD' },
};

describe('wallet balance projection', () => {
  it('starts at zero when the wallet is opened', () => {
    expect(foldBalance([opened])).toBe(0n);
  });

  it('rebuilds the balance from the event stream', () => {
    const events = [
      opened,
      moved('MoneyDeposited', 2, '100.00'),
      moved('MoneyWithdrawn', 3, '30.25'),
      moved('MoneyDeposited', 4, '0.29'),
    ];
    expect(formatCents(foldBalance(events))).toBe('70.04');
  });

  it('applies events in stream order regardless of input order', () => {
    const events = [
      moved('MoneyWithdrawn', 3, '40.00'),
      opened,
      moved('MoneyDeposited', 2, '50.00'),
    ];
    expect(formatCents(foldBalance(events))).toBe('10.00');
  });

  it('matches the incrementally maintained projection after every event', () => {
    const events = [opened];
    let live = 0n;
    for (let v = 2; v <= 50; v++) {
      const event =
        v % 3 === 0
          ? moved('MoneyWithdrawn', v, '1.10')
          : moved('MoneyDeposited', v, '2.35');
      events.push(event);
      live = applyToBalance(live, event);
      expect(foldBalance(events)).toBe(live);
    }
  });
});
