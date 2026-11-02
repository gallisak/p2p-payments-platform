import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
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
import { requestHash } from '../transfers/idempotency';
import { isUniqueViolation } from '../common/db-errors';
import { FxService } from '../fx/fx.service';
import { convertCents, parseMicro } from '../fx/fx';
import { sagaPolicyFromEnv } from '../saga/saga-policy';
import { AuthUser } from '../auth/jwt.strategy';

const MAX_DUE_MS = 365 * 24 * 3_600_000;
const LIST_LIMIT = 50;

function billRequestHash(dto: CreateSplitBillDto): string {
  return requestHash({
    title: dto.title.trim(),
    currency: dto.currency,
    totalAmount: String(dto.totalAmount),
    dueAt: dto.dueAt,
    split: dto.split,
    includeCreator: String(dto.includeCreator === true),
    participants: JSON.stringify(
      dto.participants.map((p) => [p.email.trim().toLowerCase(), p.amount ?? null]),
    ),
  });
}

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

  async create(user: AuthUser, dto: CreateSplitBillDto, idempotencyKey?: string) {
    const hash = idempotencyKey ? billRequestHash(dto) : null;
    if (idempotencyKey) {
      const known = await this.dataSource
        .getRepository(SplitBill)
        .findOne({ where: { creatorId: user.userId, idempotencyKey } });
      if (known) {
        return this.replay(user.userId, known, hash);
      }
    }
    const creatorEmail = user.email.trim().toLowerCase();
    const emails = dto.participants.map((p) => p.email.trim().toLowerCase());
    if (new Set(emails).size !== emails.length) {
      throw new BadRequestException('Each participant must be listed only once');
    }
    if (emails.includes(creatorEmail)) {
      throw new BadRequestException('The creator cannot be a participant; use includeCreator');
    }
    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now() || dueAt.getTime() > Date.now() + MAX_DUE_MS) {
      throw new BadRequestException('The due date must be in the future and within one year');
    }
    const totalCents = toCents(dto.totalAmount);
    let allocation;
    try {
      if (dto.split === 'equal') {
        if (dto.participants.some((p) => p.amount !== undefined)) {
          throw new AllocationError('Share amounts are not provided for an equal split');
        }
        allocation = allocateEqually(totalCents, emails.length, dto.includeCreator === true);
      } else {
        if (dto.includeCreator) {
          throw new AllocationError('includeCreator is only available for an equal split');
        }
        if (dto.participants.some((p) => p.amount === undefined)) {
          throw new AllocationError('Provide an amount for every share in a custom split');
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
      throw new BadRequestException('The share exceeds the per-transfer limit, so it could not be paid');
    }
    const participants = await Promise.all(emails.map((email) => this.resolveParticipant(email, dto.currency)));
    if (participants.some((p) => p.ownerId === user.userId)) {
      throw new BadRequestException('The creator cannot be a participant; use includeCreator');
    }

    const billId = randomUUID();
    const write = this.dataSource.transaction(async (manager) => {
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
          idempotencyKey: idempotencyKey ?? null,
          requestHash: hash,
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
    try {
      const { bill, shares } = await write;
      return { bill: billView(bill, shares), replayed: false };
    } catch (err) {
      if (!idempotencyKey || !isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.dataSource
        .getRepository(SplitBill)
        .findOneByOrFail({ creatorId: user.userId, idempotencyKey });
      return this.replay(user.userId, winner, hash);
    }
  }

  private async replay(userId: string, known: SplitBill, hash: string | null) {
    if (known.requestHash !== hash) {
      throw new UnprocessableEntityException('Idempotency-Key was already used for a different request');
    }
    return { bill: await this.get(userId, known.id), replayed: true };
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
      throw new NotFoundException('Share not found');
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
    const wallet = await this.ledgerCall(() => this.ledger.getWallet(dto.fromWalletId, user.userId), 'Wallet not found');
    if (wallet.currency !== bill.currency) {
      throw new BadRequestException(`The share can only be paid from a ${bill.currency} wallet`);
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
      throw new NotFoundException('Bill not found');
    }
    return { bill, shares };
  }

  private async resolveParticipant(email: string, currency: string) {
    const wallet = await this.ledgerCall(
      () => this.ledger.resolveRecipient(email, currency),
      `Participant ${email} not found`,
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
        throw new ServiceUnavailableException('ledger-service is temporarily unavailable, please try again later');
      }
      throw err;
    }
  }
}
