import {
  assertBalanced,
  depositPostings,
  externalAccount,
  withdrawalPostings,
} from '../src/ledger/ledger-events';
import { toCents } from '../src/ledger/money';

const WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';

const total = (postings: { amount: string }[]) =>
  postings.reduce((sum, p) => sum + toCents(p.amount), 0n);

describe('double-entry postings', () => {
  it('a deposit debits the external account and credits the wallet', () => {
    const postings = depositPostings(WALLET, 'USD', 4250n);

    expect(postings).toEqual([
      { accountId: externalAccount('USD'), amount: '-42.50' },
      { accountId: WALLET, amount: '42.50' },
    ]);
    expect(total(postings)).toBe(0n);
  });

  it('a withdrawal debits the wallet and credits the external account', () => {
    const postings = withdrawalPostings(WALLET, 'EUR', 1n);

    expect(postings).toEqual([
      { accountId: WALLET, amount: '-0.01' },
      { accountId: externalAccount('EUR'), amount: '0.01' },
    ]);
    expect(total(postings)).toBe(0n);
  });

  it.each([1n, 29n, 100000000n])(
    'every generated operation of %p cents sums to zero',
    (cents) => {
      expect(() => assertBalanced(depositPostings(WALLET, 'UAH', cents))).not.toThrow();
      expect(() => assertBalanced(withdrawalPostings(WALLET, 'UAH', cents))).not.toThrow();
    },
  );

  it.each([0n, -1n, -10000n])(
    'refuses to build an operation for a non-positive amount of %p cents',
    (cents) => {
      expect(() => depositPostings(WALLET, 'USD', cents)).toThrow(
        'Amount must be positive',
      );
      expect(() => withdrawalPostings(WALLET, 'USD', cents)).toThrow(
        'Amount must be positive',
      );
    },
  );

  it('rejects postings that do not sum to zero', () => {
    expect(() =>
      assertBalanced([
        { accountId: WALLET, amount: '10.00' },
        { accountId: externalAccount('USD'), amount: '-9.99' },
      ]),
    ).toThrow('Postings do not balance');
  });

  it('rejects an operation with a single posting', () => {
    expect(() => assertBalanced([{ accountId: WALLET, amount: '0.00' }])).toThrow(
      'at least two postings',
    );
  });
});
