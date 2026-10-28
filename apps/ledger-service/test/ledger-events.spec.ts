import {
  Posting,
  assertBalanced,
  depositPostings,
  externalAccount,
  fxAccount,
  transferPostings,
  withdrawalPostings,
} from '../src/ledger/ledger-events';
import { toCents } from '../src/ledger/money';

const WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';

const totalsByCurrency = (postings: Posting[]) => {
  const totals: Record<string, bigint> = {};
  for (const p of postings) {
    totals[p.currency] = (totals[p.currency] ?? 0n) + toCents(p.amount);
  }
  return totals;
};

describe('double-entry postings', () => {
  it('a deposit debits the external account and credits the wallet', () => {
    const postings = depositPostings(WALLET, 'USD', 4250n);

    expect(postings).toEqual([
      { accountId: externalAccount('USD'), amount: '-42.50', currency: 'USD' },
      { accountId: WALLET, amount: '42.50', currency: 'USD' },
    ]);
    expect(totalsByCurrency(postings)).toEqual({ USD: 0n });
  });

  it('a withdrawal debits the wallet and credits the external account', () => {
    const postings = withdrawalPostings(WALLET, 'EUR', 1n);

    expect(postings).toEqual([
      { accountId: WALLET, amount: '-0.01', currency: 'EUR' },
      { accountId: externalAccount('EUR'), amount: '0.01', currency: 'EUR' },
    ]);
    expect(totalsByCurrency(postings)).toEqual({ EUR: 0n });
  });

  it('a same-currency transfer moves money directly between wallets', () => {
    const postings = transferPostings(
      { walletId: WALLET, currency: 'USD', amount: 1000n },
      { walletId: OTHER, currency: 'USD', amount: 1000n },
    );

    expect(postings).toEqual([
      { accountId: WALLET, amount: '-10.00', currency: 'USD' },
      { accountId: OTHER, amount: '10.00', currency: 'USD' },
    ]);
  });

  it('a cross-currency transfer goes through FX accounts and balances per currency', () => {
    const postings = transferPostings(
      { walletId: WALLET, currency: 'USD', amount: 10000n },
      { walletId: OTHER, currency: 'EUR', amount: 9234n },
    );

    expect(postings).toEqual([
      { accountId: WALLET, amount: '-100.00', currency: 'USD' },
      { accountId: fxAccount('USD'), amount: '100.00', currency: 'USD' },
      { accountId: fxAccount('EUR'), amount: '-92.34', currency: 'EUR' },
      { accountId: OTHER, amount: '92.34', currency: 'EUR' },
    ]);
    expect(totalsByCurrency(postings)).toEqual({ USD: 0n, EUR: 0n });
    expect(() => assertBalanced(postings)).not.toThrow();
  });

  it('refuses a same-currency transfer that credits a different amount', () => {
    expect(() =>
      transferPostings(
        { walletId: WALLET, currency: 'USD', amount: 1000n },
        { walletId: OTHER, currency: 'USD', amount: 999n },
      ),
    ).toThrow('must credit what it debits');
  });

  it.each([1n, 29n, 100000000n])(
    'every generated operation of %p cents balances',
    (cents) => {
      const operations = [
        depositPostings(WALLET, 'UAH', cents),
        withdrawalPostings(WALLET, 'UAH', cents),
        transferPostings(
          { walletId: WALLET, currency: 'UAH', amount: cents },
          { walletId: OTHER, currency: 'UAH', amount: cents },
        ),
        transferPostings(
          { walletId: WALLET, currency: 'UAH', amount: cents },
          { walletId: OTHER, currency: 'USD', amount: cents + 7n },
        ),
      ];
      for (const postings of operations) {
        expect(() => assertBalanced(postings)).not.toThrow();
      }
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
      expect(() =>
        transferPostings(
          { walletId: WALLET, currency: 'USD', amount: cents },
          { walletId: OTHER, currency: 'EUR', amount: 100n },
        ),
      ).toThrow('Amount must be positive');
    },
  );

  it('rejects postings that do not sum to zero', () => {
    expect(() =>
      assertBalanced([
        { accountId: WALLET, amount: '10.00', currency: 'USD' },
        { accountId: externalAccount('USD'), amount: '-9.99', currency: 'USD' },
      ]),
    ).toThrow('Postings do not balance in USD');
  });

  it('rejects postings that only balance when currencies are mixed', () => {
    expect(() =>
      assertBalanced([
        { accountId: WALLET, amount: '-100.00', currency: 'USD' },
        { accountId: OTHER, amount: '100.00', currency: 'EUR' },
      ]),
    ).toThrow('Postings do not balance');
  });

  it('rejects an operation with a single posting', () => {
    expect(() =>
      assertBalanced([{ accountId: WALLET, amount: '0.00', currency: 'USD' }]),
    ).toThrow('at least two postings');
  });
});
