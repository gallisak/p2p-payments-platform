import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Hold } from './entities/hold.entity';
import { WalletLedger } from './wallet-ledger.service';
import { isUniqueViolation } from '../common/db-errors';
import { transferPostings } from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';

export interface PlaceHoldInput {
  holdId: string;
  walletId: string;
  ownerId: string;
  amount: number;
}

export interface CaptureHoldInput {
  toWalletId: string;
  amount: number;
  currency: string;
}

@Injectable()
export class HoldsService {
  constructor(
    @InjectRepository(Hold) private readonly holds: Repository<Hold>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ledger: WalletLedger,
  ) {}

  async place(input: PlaceHoldInput): Promise<Hold> {
    const cents = toCents(input.amount);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const wallet = await this.ledger.lockOwned(
          manager,
          input.walletId,
          input.ownerId,
        );
        const existing = await manager.findOne(Hold, {
          where: { id: input.holdId },
        });
        if (existing) {
          return this.samePlacement(existing, input.walletId, cents);
        }
        this.ledger.assertActive(wallet);
        if (this.ledger.available(wallet) < cents) {
          throw new BadRequestException('Недостатньо коштів');
        }
        await this.ledger.record(manager, wallet, 'HoldPlaced', {
          holdId: input.holdId,
          amount: formatCents(cents),
          currency: wallet.currency,
        });
        return manager.save(
          manager.create(Hold, {
            id: input.holdId,
            walletId: wallet.id,
            amount: formatCents(cents),
            currency: wallet.currency,
            status: 'placed',
            toWalletId: null,
            creditAmount: null,
            creditCurrency: null,
            operationId: null,
          }),
        );
      });
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const existing = await this.holds.findOneByOrFail({ id: input.holdId });
      return this.samePlacement(existing, input.walletId, cents);
    }
  }

  async release(holdId: string): Promise<Hold> {
    const { walletId } = await this.find(holdId);
    return this.dataSource.transaction(async (manager) => {
      const wallets = await this.ledger.lockAll(manager, [walletId]);
      const hold = await this.lockHold(manager, holdId);
      if (hold.status === 'released') {
        return hold;
      }
      if (hold.status === 'captured') {
        throw new ConflictException('Холд уже списано');
      }
      await this.ledger.record(manager, this.required(wallets, walletId), 'HoldReleased', {
        holdId,
        amount: hold.amount,
        currency: hold.currency,
      });
      hold.status = 'released';
      return manager.save(hold);
    });
  }

  async capture(holdId: string, input: CaptureHoldInput): Promise<Hold> {
    const { walletId } = await this.find(holdId);
    if (input.toWalletId === walletId) {
      throw new BadRequestException('Не можна переказати на той самий гаманець');
    }
    const creditCents = toCents(input.amount);
    return this.dataSource.transaction(async (manager) => {
      const wallets = await this.ledger.lockAll(manager, [walletId, input.toWalletId]);
      const hold = await this.lockHold(manager, holdId);
      if (hold.status === 'captured') {
        if (
          hold.toWalletId === input.toWalletId &&
          hold.creditCurrency === input.currency &&
          toCents(hold.creditAmount ?? '0') === creditCents
        ) {
          return hold;
        }
        throw new ConflictException('Холд уже списано з іншими параметрами');
      }
      if (hold.status === 'released') {
        throw new ConflictException('Холд уже знято');
      }
      const recipient = wallets.get(input.toWalletId);
      if (!recipient) {
        throw new NotFoundException('Гаманець отримувача не знайдено');
      }
      if (recipient.currency !== input.currency) {
        throw new BadRequestException(
          'Валюта зарахування не збігається з валютою гаманця отримувача',
        );
      }
      const sender = this.required(wallets, walletId);
      this.ledger.assertActive(sender);
      this.ledger.assertActive(recipient);
      const debitCents = toCents(hold.amount);
      if (recipient.currency === sender.currency && creditCents !== debitCents) {
        throw new BadRequestException(
          'Для переказу в тій самій валюті сума зарахування має дорівнювати сумі списання',
        );
      }

      const operationId = randomUUID();
      const postings = transferPostings(
        { walletId: sender.id, currency: sender.currency, amount: debitCents },
        {
          walletId: recipient.id,
          currency: recipient.currency,
          amount: creditCents,
        },
      );
      await this.ledger.record(manager, sender, 'TransferCompleted', {
        operationId,
        holdId,
        amount: hold.amount,
        currency: hold.currency,
        toWalletId: recipient.id,
        creditAmount: formatCents(creditCents),
        creditCurrency: recipient.currency,
        postings,
      });
      await this.ledger.record(
        manager,
        recipient,
        'TransferReceived',
        {
          operationId,
          holdId,
          fromWalletId: sender.id,
          amount: formatCents(creditCents),
          currency: recipient.currency,
        },
        sender.ownerId,
      );

      hold.status = 'captured';
      hold.toWalletId = recipient.id;
      hold.creditAmount = formatCents(creditCents);
      hold.creditCurrency = recipient.currency;
      hold.operationId = operationId;
      return manager.save(hold);
    });
  }

  private async find(holdId: string): Promise<Hold> {
    const hold = await this.holds.findOne({ where: { id: holdId } });
    if (!hold) {
      throw new NotFoundException('Холд не знайдено');
    }
    return hold;
  }

  private async lockHold(manager: EntityManager, holdId: string): Promise<Hold> {
    return manager.findOneOrFail(Hold, {
      where: { id: holdId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private required<T>(map: Map<string, T>, id: string): T {
    const value = map.get(id);
    if (!value) {
      throw new NotFoundException('Гаманець не знайдено');
    }
    return value;
  }

  private samePlacement(hold: Hold, walletId: string, cents: bigint): Hold {
    if (hold.walletId !== walletId || toCents(hold.amount) !== cents) {
      throw new ConflictException('Холд з таким id уже існує з іншими параметрами');
    }
    return hold;
  }
}
