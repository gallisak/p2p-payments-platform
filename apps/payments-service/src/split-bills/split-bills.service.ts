import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Brackets, DataSource } from 'typeorm';
import { SplitBill } from './entities/split-bill.entity';
import { SplitShare } from './entities/split-share.entity';
import { AllocationError, allocateCustom, allocateEqually } from './allocation';
import { CreateSplitBillDto } from './dto/create-split-bill.dto';
import { PayShareDto } from './dto/pay-share.dto';
import { billView } from './split-bill-view';
import { SplitBillsStore } from './split-bills.store';
import { formatCents, toCents } from '../common/money';
import { Currency } from '../common/currencies';
import { LEDGER_CLIENT, LedgerPort } from '../ledger/ledger.client';
import { LedgerRejectedError, LedgerUnavailableError } from '../ledger/ledger.errors';
import { TransfersService } from '../transfers/transfers.service';
import { FxService } from '../fx/fx.service';
import { convertCents, parseMicro } from '../fx/fx';
import { sagaPolicyFromEnv } from '../saga/saga-policy';
import { AuthUser } from '../auth/jwt.strategy';

const MAX_DUE_MS = 365 * 24 * 3_600_000;
const LIST_LIMIT = 50;

@Injectable()
export class SplitBillsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(LEDGER_CLIENT) private readonly ledger: LedgerPort,
    private readonly store: SplitBillsStore,
    private readonly transfers: TransfersService,
    private readonly fx: FxService,
  ) {}

  private readonly maxTransferUsdCents = sagaPolicyFromEnv().maxTransferUsdCents;

  async create(user: AuthUser, dto: CreateSplitBillDto) {
    const creatorEmail = user.email.trim().toLowerCase();
    const emails = dto.participants.map((p) => p.email.trim().toLowerCase());
    if (new Set(emails).size !== emails.length) {
      throw new BadRequestException('Кожен учасник має бути вказаний один раз');
    }
    if (emails.includes(creatorEmail)) {
      throw new BadRequestException('Ініціатор не може бути учасником; використайте includeCreator');
    }
    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now() || dueAt.getTime() > Date.now() + MAX_DUE_MS) {
      throw new BadRequestException('Термін оплати має бути в майбутньому, не далі ніж через рік');
    }
    const totalCents = toCents(dto.totalAmount);
    let allocation;
    try {
      if (dto.split === 'equal') {
        if (dto.participants.some((p) => p.amount !== undefined)) {
          throw new AllocationError('Для рівного розподілу суми часток не вказуються');
        }
        allocation = allocateEqually(totalCents, emails.length, dto.includeCreator === true);
      } else {
        if (dto.includeCreator) {
          throw new AllocationError('includeCreator доступний лише для рівного розподілу');
        }
        if (dto.participants.some((p) => p.amount === undefined)) {
          throw new AllocationError('Для кастомного розподілу вкажіть суму кожної частки');
        }
        allocation = allocateCustom(totalCents, dto.participants.map((p) => toCents(p.amount as number)));
      }
    } catch (err) {
      if (err instanceof AllocationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const usd = await this.fx.quote(dto.currency, 'USD');
    if (allocation.shares.some((cents) => convertCents(cents, parseMicro(usd.rate)) > this.maxTransferUsdCents)) {
      throw new BadRequestException('Частка перевищує ліміт на один переказ, тож її неможливо буде оплатити');
    }
    const participants = await Promise.all(emails.map((email) => this.resolveParticipant(email, dto.currency)));
    if (participants.some((p) => p.ownerId === user.userId)) {
      throw new BadRequestException('Ініціатор не може бути учасником; використайте includeCreator');
    }

    const billId = randomUUID();
    const { bill, shares } = await this.dataSource.transaction(async (manager) => {
      const bill = await manager.save(
        manager.create(SplitBill, {
          id: billId,
          creatorId: user.userId,
          creatorEmail,
          title: dto.title.trim(),
          currency: dto.currency,
          totalAmount: formatCents(totalCents),
          creatorAmount: formatCents(allocation.creatorCents),
          splitMode: dto.split,
          dueAt,
          status: 'pending',
          version: 1,
          settledAt: null,
        }),
      );
      const shares = await manager.save(
        participants.map((p, i) =>
          manager.create(SplitShare, {
            id: randomUUID(),
            billId,
            participantId: p.ownerId,
            participantEmail: p.email,
            amount: formatCents(allocation.shares[i]),
            status: 'pending',
            transferId: null,
            paidAt: null,
            reminderCount: 0,
            lastRemindedAt: null,
          }),
        ),
      );
      await this.store.emit(manager, 'SplitBillCreated', bill, { bill: billView(bill, shares) });
      return { bill, shares };
    });
    return billView(bill, shares);
  }

  async list(userId: string) {
    const bills = await this.dataSource
      .getRepository(SplitBill)
      .createQueryBuilder('b')
      .where(
        new Brackets((qb) => {
          qb.where('b.creatorId = :userId', { userId }).orWhere(
            'EXISTS (SELECT 1 FROM split_shares s WHERE s."billId" = b.id AND s."participantId" = :userId)',
            { userId },
          );
        }),
      )
      .orderBy('b.createdAt', 'DESC')
      .take(LIST_LIMIT)
      .getMany();
    if (bills.length === 0) {
      return [];
    }
    const shares = await this.dataSource
      .getRepository(SplitShare)
      .createQueryBuilder('s')
      .where('s.billId IN (:...ids)', { ids: bills.map((b) => b.id) })
      .orderBy('s.participantEmail', 'ASC')
      .getMany();
    return bills.map((b) => billView(b, shares.filter((s) => s.billId === b.id)));
  }

  async get(userId: string, billId: string) {
    const { bill, shares } = await this.visible(userId, billId);
    return billView(bill, shares);
  }

  async payShare(user: AuthUser, billId: string, shareId: string, key: string, dto: PayShareDto) {
    const { bill, shares } = await this.visible(user.userId, billId);
    const share = shares.find((s) => s.id === shareId);
    if (!share || share.participantId !== user.userId) {
      throw new NotFoundException('Частку не знайдено');
    }
    const payment = {
      fromWalletId: dto.fromWalletId,
      toWalletIdentifier: bill.creatorEmail,
      amount: Number(share.amount),
      currency: bill.currency as Currency,
    };
    if (await this.transfers.exists(user.userId, key)) {
      return this.transfers.create(user.userId, key, payment, { billId, shareId });
    }
    const wallet = await this.ledgerCall(() => this.ledger.getWallet(dto.fromWalletId, user.userId), 'Гаманець не знайдено');
    if (wallet.currency !== bill.currency) {
      throw new BadRequestException(`Частку можна оплатити лише з гаманця в ${bill.currency}`);
    }
    return this.transfers.create(user.userId, key, payment, { billId, shareId });
  }

  private async visible(userId: string, billId: string) {
    const bill = await this.dataSource.getRepository(SplitBill).findOne({ where: { id: billId } });
    const shares = bill
      ? await this.dataSource.getRepository(SplitShare).find({
          where: { billId },
          order: { participantEmail: 'ASC' },
        })
      : [];
    if (!bill || (bill.creatorId !== userId && !shares.some((s) => s.participantId === userId))) {
      throw new NotFoundException('Рахунок не знайдено');
    }
    return { bill, shares };
  }

  private async resolveParticipant(email: string, currency: string) {
    const wallet = await this.ledgerCall(
      () => this.ledger.resolveRecipient(email, currency),
      `Учасника ${email} не знайдено`,
    );
    return { email, ownerId: wallet.ownerId };
  }

  private async ledgerCall<T>(call: () => Promise<T>, notFound: string): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof LedgerRejectedError && err.status === 404) {
        throw new BadRequestException(notFound);
      }
      if (err instanceof LedgerUnavailableError) {
        throw new ServiceUnavailableException('ledger-service тимчасово недоступний, спробуйте пізніше');
      }
      throw err;
    }
  }
}
