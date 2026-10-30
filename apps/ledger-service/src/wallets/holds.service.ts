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
          throw new BadRequestException('Insufficient funds');
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

  async release(holdId: string, walletId?: string): Promise<Hold> {
    const known = await this.holds.findOne({ where: { id: holdId } });
    const target = known?.walletId ?? walletId;
    if (!target) {
      throw new NotFoundException('Hold not found');
    }
    if (walletId && target !== walletId) {
      throw new BadRequestException('The hold belongs to another wallet');
    }
    return this.dataSource.transaction(async (manager) => {
      const wallets = await this.ledger.lockAll(manager, [target]);
      const wallet = this.required(wallets, target);
      const hold = await manager.findOne(Hold, {
        where: { id: holdId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!hold) {
        return manager.save(
          manager.create(Hold, {
            id: holdId,
            walletId: wallet.id,
            amount: '0.00',
            currency: wallet.currency,
            status: 'voided',
            toWalletId: null,
            creditAmount: null,
            creditCurrency: null,
            operationId: null,
          }),
        );
      }
      if (hold.walletId !== target) {
        throw new BadRequestException('The hold belongs to another wallet');
      }
      if (hold.status === 'released' || hold.status === 'voided') {
        return hold;
      }
      if (hold.status === 'captured') {
        throw new ConflictException('The hold was already captured');
      }
      await this.ledger.record(manager, wallet, 'HoldReleased', {
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
      throw new BadRequestException('Cannot transfer to the same wallet');
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
        throw new ConflictException('The hold was already captured with different parameters');
      }
      if (hold.status === 'released' || hold.status === 'voided') {
        throw new ConflictException('The hold was already released');
      }
      const recipient = wallets.get(input.toWalletId);
      if (!recipient) {
        throw new NotFoundException('Recipient wallet not found');
      }
      if (recipient.currency !== input.currency) {
        throw new BadRequestException(
          'The credit currency does not match the recipient wallet currency',
        );
      }
      const sender = this.required(wallets, walletId);
      this.ledger.assertActive(sender);
      this.ledger.assertActive(recipient);
      const debitCents = toCents(hold.amount);
      if (recipient.currency === sender.currency && creditCents !== debitCents) {
        throw new BadRequestException(
          'For a same-currency transfer the credit amount must equal the debit amount',
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
      throw new NotFoundException('Hold not found');
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
      throw new NotFoundException('Wallet not found');
    }
    return value;
  }

  private samePlacement(hold: Hold, walletId: string, cents: bigint): Hold {
    if (hold.status === 'voided') {
      throw new ConflictException('The hold was already voided');
    }
    if (hold.walletId !== walletId || toCents(hold.amount) !== cents) {
      throw new ConflictException('A hold with this id already exists with different parameters');
    }
    return hold;
  }
}
