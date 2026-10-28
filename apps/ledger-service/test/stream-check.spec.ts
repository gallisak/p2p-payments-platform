import { StoredEvent } from '../src/ledger/ledger-events';
import { formatCents } from '../src/ledger/money';
import { checkStream } from '../src/ledger/stream-check';

const opened: StoredEvent = {
  type: 'WalletOpened',
  schemaVersion: 1,
  streamVersion: 1,
  payload: { ownerId: 'owner', currency: 'USD' },
};

const deposit = (streamVersion: number, amount: string): StoredEvent => ({
  type: 'MoneyDeposited',
  schemaVersion: 2,
  streamVersion,
  payload: { operationId: `op-${streamVersion}`, amount, currency: 'USD', postings: [] },
});

describe('event stream check', () => {
  it('rebuilds a healthy stream without issues', () => {
    const check = checkStream([opened, deposit(2, '10.00'), deposit(3, '5.50')]);

    expect(check.issues).toEqual([]);
    expect(check.version).toBe(3);
    expect(formatCents(check.state.balance)).toBe('15.50');
  });

  it('reports a gap in stream versions', () => {
    const check = checkStream([opened, deposit(2, '10.00'), deposit(4, '1.00')]);

    expect(check.issues).toEqual(['version gap: expected 3, found 4']);
    expect(check.version).toBe(4);
  });

  it('reports a stream that does not start with WalletOpened', () => {
    const check = checkStream([{ ...deposit(1, '10.00') }]);

    expect(check.issues).toContain('stream starts with MoneyDeposited, not WalletOpened');
  });

  it('reports an empty stream', () => {
    expect(checkStream([]).issues).toEqual(['stream has no events']);
  });

  it('reports an event from an unknown future schema instead of crashing', () => {
    const check = checkStream([opened, { ...deposit(2, '10.00'), schemaVersion: 99 }]);

    expect(check.issues).toEqual([
      expect.stringContaining('event v2 cannot be applied'),
    ]);
  });

  it('tracks the blocked flag through block and unblock events', () => {
    const blocked: StoredEvent = {
      type: 'WalletBlocked',
      schemaVersion: 1,
      streamVersion: 2,
      payload: { reason: 'fraud check' },
    };
    const unblocked: StoredEvent = {
      type: 'WalletUnblocked',
      schemaVersion: 1,
      streamVersion: 3,
      payload: {},
    };

    expect(checkStream([opened, blocked]).state.blocked).toBe(true);
    expect(checkStream([opened, blocked, unblocked]).state.blocked).toBe(false);
  });
});
