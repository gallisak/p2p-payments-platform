import { CURRENT_SCHEMA_VERSION, StoredEvent } from '../src/ledger/ledger-events';
import { upcast } from '../src/ledger/upcasters';

const v1Deposit: StoredEvent = {
  type: 'MoneyDeposited',
  schemaVersion: 1,
  streamVersion: 2,
  payload: {
    operationId: 'op-1',
    amount: '10.00',
    currency: 'USD',
    postings: [],
  },
};

describe('event upcasting', () => {
  it('returns events that are already at the current version unchanged', () => {
    expect(upcast(v1Deposit)).toEqual(v1Deposit);
  });

  it('upgrades an old event step by step to the current version', () => {
    const versions = { ...CURRENT_SCHEMA_VERSION, MoneyDeposited: 3 };
    const registry = {
      'MoneyDeposited@1': (p: Record<string, unknown>) => ({
        ...p,
        source: 'card',
      }),
      'MoneyDeposited@2': (p: Record<string, unknown>) => ({
        ...p,
        source: undefined,
        channel: p.source,
      }),
    };

    const upgraded = upcast(v1Deposit, registry, versions);

    expect(upgraded.schemaVersion).toBe(3);
    expect(upgraded.payload).toMatchObject({ amount: '10.00', channel: 'card' });
    expect(v1Deposit.schemaVersion).toBe(1);
  });

  it('fails loudly when an upcaster step is missing', () => {
    const versions = { ...CURRENT_SCHEMA_VERSION, MoneyDeposited: 2 };
    expect(() => upcast(v1Deposit, {}, versions)).toThrow(
      'No upcaster for MoneyDeposited v1',
    );
  });

  it('refuses events from a newer schema than this service understands', () => {
    expect(() => upcast({ ...v1Deposit, schemaVersion: 99 })).toThrow(
      'newer than supported',
    );
  });
});
