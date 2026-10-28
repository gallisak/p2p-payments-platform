import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { EventStore } from '../ledger/event-store.service';
import {
  CURRENT_SCHEMA_VERSION,
  LedgerEventPayloads,
  LedgerEventType,
} from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';
import { applyEvent } from '../ledger/wallet-projection';

export const WALLET_LOCKED_STATUS = 423;

@Injectable()
export class WalletLedger {
  constructor(private readonly eventStore: EventStore) {}

  async lockOwned(
    manager: EntityManager,
    walletId: string,
    ownerId: string,
  ): Promise<Wallet> {
    const wallet = await manager.findOne(Wallet, {
      where: { id: walletId, ownerId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!wallet) {
      throw new NotFoundException('Гаманець не знайдено');
    }
    return wallet;
  }

  async lockAll(
    manager: EntityManager,
    walletIds: string[],
  ): Promise<Map<string, Wallet>> {
    const locked = new Map<string, Wallet>();
    for (const id of [...new Set(walletIds)].sort()) {
      const wallet = await manager.findOne(Wallet, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (wallet) {
        locked.set(id, wallet);
      }
    }
    return locked;
  }

  assertActive(wallet: Wallet): void {
    if (wallet.blocked) {
      throw new HttpException('Гаманець заблоковано', WALLET_LOCKED_STATUS);
    }
  }

  available(wallet: Wallet): bigint {
    return toCents(wallet.balance) - toCents(wallet.held);
  }

  async record<T extends LedgerEventType>(
    manager: EntityManager,
    wallet: Wallet,
    type: T,
    payload: LedgerEventPayloads[T],
    actorId: string = wallet.ownerId,
  ): Promise<Wallet> {
    const event = await this.eventStore.append(manager, {
      streamId: wallet.id,
      expectedVersion: wallet.version,
      type,
      payload,
      metadata: { actorId },
    });
    const state = applyEvent(
      {
        balance: toCents(wallet.balance),
        held: toCents(wallet.held),
        blocked: wallet.blocked,
      },
      {
        type,
        schemaVersion: CURRENT_SCHEMA_VERSION[type],
        streamVersion: event.streamVersion,
        payload,
      },
    );
    wallet.balance = formatCents(state.balance);
    wallet.held = formatCents(state.held);
    wallet.blocked = state.blocked;
    wallet.version = event.streamVersion;
    return manager.save(wallet);
  }
}
