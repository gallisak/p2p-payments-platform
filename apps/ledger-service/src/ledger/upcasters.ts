import {
  CURRENT_SCHEMA_VERSION,
  LedgerEventType,
  StoredEvent,
} from './ledger-events';

export type Upcaster = (
  payload: Record<string, unknown>,
) => Record<string, unknown>;

export type UpcasterRegistry = Partial<Record<string, Upcaster>>;

const addCurrencyToPostings: Upcaster = (payload) => ({
  ...payload,
  postings: (payload.postings as Record<string, unknown>[]).map((posting) => ({
    ...posting,
    currency: payload.currency,
  })),
});

export const UPCASTERS: UpcasterRegistry = {
  'MoneyDeposited@1': addCurrencyToPostings,
  'MoneyWithdrawn@1': addCurrencyToPostings,
};

export function upcast(
  event: StoredEvent,
  registry: UpcasterRegistry = UPCASTERS,
  currentVersions: Record<LedgerEventType, number> = CURRENT_SCHEMA_VERSION,
): StoredEvent {
  const target = currentVersions[event.type];
  if (target === undefined) {
    throw new Error(`Unknown event type ${event.type}`);
  }
  if (event.schemaVersion > target) {
    throw new Error(
      `${event.type} v${event.schemaVersion} is newer than supported v${target}`,
    );
  }
  let payload = event.payload as unknown as Record<string, unknown>;
  for (let version = event.schemaVersion; version < target; version++) {
    const step = registry[`${event.type}@${version}`];
    if (!step) {
      throw new Error(`No upcaster for ${event.type} v${version}`);
    }
    payload = step(payload);
  }
  return {
    ...event,
    schemaVersion: target,
    payload: payload as unknown as StoredEvent['payload'],
  };
}
