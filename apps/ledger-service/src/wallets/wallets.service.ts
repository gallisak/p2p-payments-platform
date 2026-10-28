import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { Currency } from './wallets.constants';
import { EventStore } from '../ledger/event-store.service';
import {
  LedgerEventType,
  MoneyMovedPayload,
  Posting,
  depositPostings,
  withdrawalPostings,
} from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';
import { applyToBalance } from '../ledger/wallet-projection';

const UNIQUE_VIOLATION = '23505';

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventStore: EventStore,
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
      throw new NotFoundException('Гаманець не знайдено');
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
        return manager.save(
          manager.create(Wallet, {
            id: walletId,
            ownerId,
            currency,
            balance: '0.00',
            version: event.streamVersion,
          }),
        );
      });
    } catch (err) {
      if (!this.isUniqueViolation(err)) {
        throw err;
      }
      return this.wallets.findOneOrFail({ where: { ownerId, currency } });
    }
  }

  async deposit(
    walletId: string,
    ownerId: string,
    amount: number,
  ): Promise<Wallet> {
    const cents = toCents(amount);
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, walletId, ownerId);
      return this.record(
        manager,
        wallet,
        'MoneyDeposited',
        cents,
        depositPostings(wallet.id, wallet.currency, cents),
      );
    });
  }

  async withdraw(
    walletId: string,
    ownerId: string,
    amount: number,
  ): Promise<Wallet> {
    const cents = toCents(amount);
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.lockWallet(manager, walletId, ownerId);
      if (toCents(wallet.balance) < cents) {
        throw new BadRequestException('Недостатньо коштів');
      }
      return this.record(
        manager,
        wallet,
        'MoneyWithdrawn',
        cents,
        withdrawalPostings(wallet.id, wallet.currency, cents),
      );
    });
  }

  private async lockWallet(
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

  private async record(
    manager: EntityManager,
    wallet: Wallet,
    type: Extract<LedgerEventType, 'MoneyDeposited' | 'MoneyWithdrawn'>,
    cents: bigint,
    postings: Posting[],
  ): Promise<Wallet> {
    const payload: MoneyMovedPayload = {
      operationId: randomUUID(),
      amount: formatCents(cents),
      currency: wallet.currency,
      postings,
    };
    const event = await this.eventStore.append(manager, {
      streamId: wallet.id,
      expectedVersion: wallet.version,
      type,
      payload,
      metadata: { actorId: wallet.ownerId },
    });
    const balance = applyToBalance(toCents(wallet.balance), {
      type,
      schemaVersion: event.schemaVersion,
      streamVersion: event.streamVersion,
      payload,
    });
    wallet.balance = formatCents(balance);
    wallet.version = event.streamVersion;
    return manager.save(wallet);
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof QueryFailedError &&
      (err.driverError as { code?: string } | undefined)?.code ===
        UNIQUE_VIOLATION
    );
  }
}
