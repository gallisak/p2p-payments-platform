import { CURRENT_SCHEMA_VERSION, StoredEvent } from '../src/ledger/ledger-events';
import { upcast } from '../src/ledger/upcasters';

const WALLET = 'aaaaaaaa-1111-4111-8111-111111111111';

function v1(type: 'MoneyDeposited' | 'MoneyWithdrawn'): StoredEvent {
  return {
    type,
    schemaVersion: 1,
    streamVersion: 2,
    payload: {
      operationId: 'op-1',
      amount: '10.00',
      currency: 'EUR',
      postings: [
        { accountId: 'external:EUR', amount: '-10.00' },
        { accountId: WALLET, amount: '10.00' },
      ],
    } as unknown as StoredEvent['payload'],
  };
}

describe('event upcasting', () => {
  it.each(['MoneyDeposited', 'MoneyWithdrawn'] as const)(
    'upgrades a v1 %s from the PR4 log by adding the currency to every posting',
    (type) => {
      const original = v1(type);
      const upgraded = upcast(original);

      expect(upgraded.schemaVersion).toBe(2);
      expect(upgraded.payload).toEqual({
        operationId: 'op-1',
        amount: '10.00',
        currency: 'EUR',
        postings: [
          { accountId: 'external:EUR', amount: '-10.00', currency: 'EUR' },
          { accountId: WALLET, amount: '10.00', currency: 'EUR' },
        ],
      });
      expect(original.schemaVersion).toBe(1);
      expect(
        (original.payload as { postings: object[] }).postings[0],
      ).not.toHaveProperty('currency');
    },
  );

  it('returns events that are already at the current version unchanged', () => {
    const current = upcast(v1('MoneyDeposited'));
    expect(upcast(current)).toEqual(current);
  });

  it('upgrades an old event step by step through a chain of upcasters', () => {
    const versions = { ...CURRENT_SCHEMA_VERSION, MoneyDeposited: 3 };
    const registry = {
      'MoneyDeposited@1': (p: Record<string, unknown>) => ({ ...p, source: 'card' }),
      'MoneyDeposited@2': (p: Record<string, unknown>) => ({
        ...p,
        source: undefined,
        channel: p.source,
      }),
    };

    const upgraded = upcast(v1('MoneyDeposited'), registry, versions);

    expect(upgraded.schemaVersion).toBe(3);
    expect(upgraded.payload).toMatchObject({ amount: '10.00', channel: 'card' });
  });

  it('fails loudly when an upcaster step is missing', () => {
    expect(() => upcast(v1('MoneyDeposited'), {})).toThrow(
      'No upcaster for MoneyDeposited v1',
    );
  });

  it('refuses events from a newer schema than this service understands', () => {
    expect(() => upcast({ ...v1('MoneyDeposited'), schemaVersion: 99 })).toThrow(
      'newer than supported',
    );
  });
});
