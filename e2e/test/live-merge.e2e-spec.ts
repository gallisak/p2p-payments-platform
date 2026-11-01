import { LiveTransfer, LiveWallet, latestTransfer, latestWallet } from '../../apps/frontend/lib/realtime-state';
import { Transfer, Wallet } from '../../apps/frontend/lib/types';
import { availableAmount } from '../../apps/frontend/lib/money';
import { parseParticipants } from '../../apps/frontend/lib/split-participants';

const wallet: Wallet = { id: 'w', currency: 'USD', balance: '107.00', held: '0.00', blocked: false, version: 3 };
const live = (streamVersion: number, balance: string): LiveWallet => ({
  walletId: 'w',
  currency: 'USD',
  balance,
  held: '0.00',
  blocked: false,
  streamVersion,
});

const transfer = (status: string, updatedAt: string) => ({ id: 't', status, updatedAt }) as Transfer;
const liveTransfer = (t: Transfer): LiveTransfer => ({ transferId: t.id, status: t.status, streamVersion: 1, transfer: t });

describe('Merging server data with live updates', () => {
  it('keeps the server balance when the live one is older', () => {
    expect(latestWallet(wallet, live(2, '100.00')).balance).toBe('107.00');
  });

  it('takes a live balance of the same or a newer version', () => {
    expect(latestWallet(wallet, live(3, '107.00')).balance).toBe('107.00');
    expect(latestWallet(wallet, live(4, '120.00'))).toMatchObject({ balance: '120.00', version: 4 });
  });

  it('keeps the server wallet when there is no live update', () => {
    expect(latestWallet(wallet, undefined)).toBe(wallet);
  });

  it('keeps the server transfer when the live one is older', () => {
    const server = transfer('completed', '2026-11-02T10:00:02.000Z');
    const stale = liveTransfer(transfer('checked', '2026-11-02T10:00:01.000Z'));

    expect(latestTransfer(server, stale).status).toBe('completed');
  });

  it('takes a newer live transfer', () => {
    const server = transfer('checked', '2026-11-02T10:00:01.000Z');
    const fresh = liveTransfer(transfer('completed', '2026-11-02T10:00:02.000Z'));

    expect(latestTransfer(server, fresh).status).toBe('completed');
  });
});

describe('Participants of a split bill', () => {
  it.each([
    ['a@example.com 10,50', 10.5],
    ['a@example.com 10.50', 10.5],
    ['a@example.com, 10,50', 10.5],
    ['a@example.com;10.50', 10.5],
  ])('reads %s', (line, amount) => {
    expect(parseParticipants(line, true)).toEqual([{ email: 'a@example.com', amount }]);
  });

  it('reports a missing custom amount and ignores blank lines', () => {
    expect(parseParticipants('a@example.com\n\n', true)).toEqual([{ email: 'a@example.com', amount: null }]);
  });

  it('reads only the email for an equal split', () => {
    expect(parseParticipants('a@example.com 5\nb@example.com', false)).toEqual([
      { email: 'a@example.com' },
      { email: 'b@example.com' },
    ]);
  });
});

describe('Available amount', () => {
  it.each([
    ['100.00', '40.00', '60.00'],
    ['100.05', '0.10', '99.95'],
    ['0.09', '0.00', '0.09'],
    ['40.00', '40.00', '0.00'],
  ])('%s with %s held leaves %s', (balance, held, expected) => {
    expect(availableAmount({ balance, held })).toBe(expected);
  });
});
