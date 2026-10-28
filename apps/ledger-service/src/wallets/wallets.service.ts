import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';
import { Currency } from './wallets.constants';
import { WalletLedger } from './wallet-ledger.service';
import { EventStore } from '../ledger/event-store.service';
import { depositPostings, withdrawalPostings } from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';
import { isUniqueViolation } from '../common/db-errors';

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventStore: EventStore,
    private readonly ledger: WalletLedger,
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
            held: '0.00',
            version: event.streamVersion,
          }),
        );
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
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
      const wallet = await this.ledger.lockOwned(manager, walletId, ownerId);
      return this.ledger.record(manager, wallet, 'MoneyDeposited', {
        operationId: randomUUID(),
        amount: formatCents(cents),
        currency: wallet.currency,
        postings: depositPostings(wallet.id, wallet.currency, cents),
      });
    });
  }

  async withdraw(
    walletId: string,
    ownerId: string,
    amount: number,
  ): Promise<Wallet> {
    const cents = toCents(amount);
    return this.dataSource.transaction(async (manager) => {
      const wallet = await this.ledger.lockOwned(manager, walletId, ownerId);
      if (this.ledger.available(wallet) < cents) {
        throw new BadRequestException('Недостатньо коштів');
      }
      return this.ledger.record(manager, wallet, 'MoneyWithdrawn', {
        operationId: randomUUID(),
        amount: formatCents(cents),
        currency: wallet.currency,
        postings: withdrawalPostings(wallet.id, wallet.currency, cents),
      });
    });
  }
}
