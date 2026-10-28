import { StoredEvent } from './ledger-events';
import { EMPTY_WALLET, WalletState, applyEvent } from './wallet-projection';
import { upcast } from './upcasters';

export interface StreamCheck {
  state: WalletState;
  version: number;
  issues: string[];
}

export function checkStream(events: StoredEvent[]): StreamCheck {
  const ordered = [...events].sort((a, b) => a.streamVersion - b.streamVersion);
  const issues: string[] = [];
  if (ordered.length === 0) {
    return { state: EMPTY_WALLET, version: 0, issues: ['stream has no events'] };
  }
  if (ordered[0].type !== 'WalletOpened') {
    issues.push(`stream starts with ${ordered[0].type}, not WalletOpened`);
  }
  let state = EMPTY_WALLET;
  let version = 0;
  for (const event of ordered) {
    if (event.streamVersion !== version + 1) {
      issues.push(`version gap: expected ${version + 1}, found ${event.streamVersion}`);
    }
    version = event.streamVersion;
    try {
      state = applyEvent(state, upcast(event));
    } catch (err) {
      issues.push(`event v${event.streamVersion} cannot be applied: ${(err as Error).message}`);
    }
  }
  return { state, version, issues };
}
