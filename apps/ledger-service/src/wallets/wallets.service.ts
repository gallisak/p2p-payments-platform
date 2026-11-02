import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { Wallet } from './entities/wallet.entity';
import { Currency } from './wallets.constants';
import { WalletLedger } from './wallet-ledger.service';
import { EventStore } from '../ledger/event-store.service';
import { depositPostings, withdrawalPostings } from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';
import { isUniqueViolation } from '../common/db-errors';
import { requestHash } from '../common/idempotency';
import { OutboxWriter } from '../outbox/outbox.writer';

export interface WalletOperation {
  wallet: Wallet;
  replayed: boolean;
}

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventStore: EventStore,
    private readonly ledger: WalletLedger,
    private readonly outbox: OutboxWriter,
  ) {}

  async listForUser(userId: string): Promise<Wallet[]> {
    return this.wallets.find({
      where: { ownerId: userId },
      order: { currency: 'ASC' },
    });
  }

  async getById(walletId: string, ownerId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOne({
      where: { id: walletId, ownerId },
    });
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  async open(ownerId: string, currency: Currency): Promise<Wallet> {
    const existing = await this.wallets.findOne({
      where: { ownerId, currency },
    });
    if (existing) {
      return existing;
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const walletId = randomUUID();
        const event = await this.eventStore.append(manager, {
          streamId: walletId,
          expectedVersion: 0,
          type: 'WalletOpened',
          payload: { ownerId, currency },
          metadata: { actorId: ownerId },
        });
        const wallet = await manager.save(
          manager.create(Wallet, {
            id: walletId,
            ownerId,
            currency,
            balance: '0.00',
            held: '0.00',
            blocked: false,
            version: event.streamVersion,
          }),
        );
        await this.outbox.enqueue(manager, event, wallet);
        return wallet;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      return this.wallets.findOneOrFail({ where: { ownerId, currency } });
    }
  }

  async block(walletId: string, actorId: string, reason: string): Promise<Wallet> {
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockExisting(manager, walletId);
      if (wallet.blocked) {
        return wallet;
      }
      return this.ledger.record(manager, wallet, 'WalletBlocked', { reason }, actorId);
    });
  }

  async unblock(walletId: string, actorId: string): Promise<Wallet> {
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockExisting(manager, walletId);
      if (!wallet.blocked) {
        return wallet;
      }
      return this.ledger.record(manager, wallet, 'WalletUnblocked', {}, actorId);
    });
  }

  private async lockExisting(manager: EntityManager, walletId: string): Promise<Wallet> {
    const wallet = (await this.ledger.lockAll(manager, [walletId])).get(walletId);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return wallet;
  }

  async deposit(
    walletId: string,
    ownerId: string,
    amount: number,
    idempotencyKey?: string,
  ): Promise<WalletOperation> {
    const cents = toCents(amount);
    const scope = { walletId, ownerId, idempotencyKey };
    return this.once(scope, 'deposit', cents, (manager, wallet) =>
      this.ledger.record(manager, wallet, 'MoneyDeposited', {
        operationId: randomUUID(),
        amount: formatCents(cents),
        currency: wallet.currency,
        postings: depositPostings(wallet.id, wallet.currency, cents),
      }),
    );
  }

  async withdraw(
    walletId: string,
    ownerId: string,
    amount: number,
    idempotencyKey?: string,
  ): Promise<WalletOperation> {
    const cents = toCents(amount);
    const scope = { walletId, ownerId, idempotencyKey };
    return this.once(scope, 'withdrawal', cents, (manager, wallet) => {
      if (this.ledger.available(wallet) < cents) {
        throw new BadRequestException('Insufficient funds');
      }
      return this.ledger.record(manager, wallet, 'MoneyWithdrawn', {
        operationId: randomUUID(),
        amount: formatCents(cents),
        currency: wallet.currency,
        postings: withdrawalPostings(wallet.id, wallet.currency, cents),
      });
    });
  }

  private async once(
    scope: { walletId: string; ownerId: string; idempotencyKey?: string },
    operation: string,
    cents: bigint,
    apply: (manager: EntityManager, wallet: Wallet) => Promise<Wallet>,
  ): Promise<WalletOperation> {
    const { walletId, ownerId, idempotencyKey: key } = scope;
    const hash = requestHash({ operation, walletId, amount: formatCents(cents) });
    try {
      return await this.dataSource.transaction(async (manager) => {
        const wallet = await this.ledger.lockOwned(manager, walletId, ownerId);
        if (key) {
          const known = await manager.findOneBy(IdempotencyKey, { ownerId, key });
          if (known) {
            this.assertSameRequest(known, hash);
            return { wallet, replayed: true };
          }
        }
        this.ledger.assertActive(wallet);
        const saved = await apply(manager, wallet);
        if (key) {
          await manager.insert(IdempotencyKey, { ownerId, key, requestHash: hash });
        }
        return { wallet: saved, replayed: false };
      });
    } catch (err) {
      if (!key || !isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.dataSource.manager.findOneByOrFail(IdempotencyKey, { ownerId, key });
      this.assertSameRequest(winner, hash);
      return { wallet: await this.getById(walletId, ownerId), replayed: true };
    }
  }

  private assertSameRequest(known: IdempotencyKey, hash: string): void {
    if (known.requestHash !== hash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key was already used for a different request',
      );
    }
  }
}
