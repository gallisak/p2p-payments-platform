import { MoneyMovedPayload, StoredEvent } from './ledger-events';
import { toCents } from './money';
import { upcast } from './upcasters';

export function applyToBalance(balance: bigint, event: StoredEvent): bigint {
  switch (event.type) {
    case 'WalletOpened':
      return 0n;
    case 'MoneyDeposited':
      return balance + toCents((event.payload as MoneyMovedPayload).amount);
    case 'MoneyWithdrawn':
      return balance - toCents((event.payload as MoneyMovedPayload).amount);
    default:
      throw new Error(`Unhandled event type ${String(event.type)}`);
  }
}

export function foldBalance(events: StoredEvent[]): bigint {
  return [...events]
    .sort((a, b) => a.streamVersion - b.streamVersion)
    .map((event) => upcast(event))
    .reduce(applyToBalance, 0n);
}
