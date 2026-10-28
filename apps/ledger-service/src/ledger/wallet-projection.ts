import {
  HoldPayload,
  MoneyMovedPayload,
  StoredEvent,
  TransferCompletedPayload,
  TransferReceivedPayload,
} from './ledger-events';
import { toCents } from './money';
import { upcast } from './upcasters';

export interface WalletState {
  balance: bigint;
  held: bigint;
}

export const EMPTY_WALLET: WalletState = { balance: 0n, held: 0n };

export function applyEvent(state: WalletState, event: StoredEvent): WalletState {
  switch (event.type) {
    case 'WalletOpened':
      return EMPTY_WALLET;
    case 'MoneyDeposited':
      return {
        ...state,
        balance: state.balance + toCents((event.payload as MoneyMovedPayload).amount),
      };
    case 'MoneyWithdrawn':
      return {
        ...state,
        balance: state.balance - toCents((event.payload as MoneyMovedPayload).amount),
      };
    case 'HoldPlaced':
      return {
        ...state,
        held: state.held + toCents((event.payload as HoldPayload).amount),
      };
    case 'HoldReleased':
      return {
        ...state,
        held: state.held - toCents((event.payload as HoldPayload).amount),
      };
    case 'TransferCompleted': {
      const amount = toCents((event.payload as TransferCompletedPayload).amount);
      return { balance: state.balance - amount, held: state.held - amount };
    }
    case 'TransferReceived':
      return {
        ...state,
        balance:
          state.balance + toCents((event.payload as TransferReceivedPayload).amount),
      };
    default:
      throw new Error(`Unhandled event type ${String(event.type)}`);
  }
}

export function foldWallet(events: StoredEvent[]): WalletState {
  return [...events]
    .sort((a, b) => a.streamVersion - b.streamVersion)
    .map((event) => upcast(event))
    .reduce(applyEvent, EMPTY_WALLET);
}
