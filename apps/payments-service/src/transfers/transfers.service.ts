import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { Transfer } from './entities/transfer.entity';
import { SagaStep } from './entities/saga-step.entity';
import { requestHash } from './idempotency';
import { stepView, transferView } from './transfer-view';
import { formatCents, toCents } from '../common/money';
import { isUniqueViolation } from '../common/db-errors';
import { OutboxWriter } from '../outbox/outbox.writer';
import { SagaWorker } from '../saga/saga.worker';
import { SplitBillsStore } from '../split-bills/split-bills.store';
import { currentTraceparent } from '../telemetry/trace-context';

const MAX_STEPS_IN_VIEW = 100;

export interface CreatedTransfer {
  transfer: ReturnType<typeof transferView>;
  replayed: boolean;
}

@Injectable()
export class TransfersService {
  constructor(
    @InjectRepository(Transfer) private readonly transfers: Repository<Transfer>,
    @InjectRepository(SagaStep) private readonly steps: Repository<SagaStep>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxWriter,
    private readonly worker: SagaWorker,
    private readonly splitBills: SplitBillsStore,
  ) {}

  async create(
    senderId: string,
    idempotencyKey: string,
    dto: CreateTransferDto,
    splitShare?: { billId: string; shareId: string },
  ): Promise<CreatedTransfer> {
    const amount = formatCents(toCents(dto.amount));
    const recipientEmail = dto.toWalletIdentifier.trim().toLowerCase();
    const hash = requestHash({
      fromWalletId: dto.fromWalletId,
      toWalletIdentifier: recipientEmail,
      amount,
      currency: dto.currency,
      ...(splitShare ? { splitShareId: splitShare.shareId } : {}),
    });
    const existing = await this.transfers.findOne({ where: { senderId, idempotencyKey } });
    if (existing) {
      return this.replay(existing, hash);
    }
    try {
      const created = await this.dataSource.transaction(async (manager) => {
        const now = new Date();
        const transfer = await manager.save(
          manager.create(Transfer, {
            id: randomUUID(),
            senderId,
            idempotencyKey,
            requestHash: hash,
            fromWalletId: dto.fromWalletId,
            recipientEmail,
            amount,
            toCurrency: dto.currency,
            fromCurrency: null,
            recipientId: null,
            toWalletId: null,
            creditAmount: null,
            rate: null,
            rateExpiresAt: null,
            limitCents: null,
            status: 'pending',
            failureReason: null,
            failureDetail: null,
            attempts: 0,
            awaitingRetry: false,
            lastError: null,
            nextAttemptAt: now,
            deadlineAt: new Date(now.getTime() + this.worker.timeoutMs),
            version: 1,
            completedAt: null,
            splitShareId: splitShare?.shareId ?? null,
            traceContext: currentTraceparent(),
          }),
        );
        if (splitShare) {
          await this.splitBills.linkPayment(manager, splitShare, senderId, transfer.id);
        }
        await this.outbox.enqueue(manager, 'TransferInitiated', transfer);
        return transfer;
      });
      this.worker.kick();
      return { transfer: transferView(created), replayed: false };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      const winner = await this.transfers.findOneByOrFail({ senderId, idempotencyKey });
      return this.replay(winner, hash);
    }
  }

  async exists(senderId: string, idempotencyKey: string): Promise<boolean> {
    return this.transfers.exists({ where: { senderId, idempotencyKey } });
  }

  async get(senderId: string, id: string) {
    const transfer = await this.transfers.findOne({ where: { id, senderId } });
    if (!transfer) {
      throw new NotFoundException('Transfer not found');
    }
    const steps = await this.steps.find({
      where: { transferId: id },
      order: { id: 'DESC' },
      take: MAX_STEPS_IN_VIEW,
    });
    return { ...transferView(transfer), steps: steps.reverse().map(stepView) };
  }

  async list(senderId: string, limit = 20) {
    const transfers = await this.transfers.find({
      where: { senderId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return transfers.map(transferView);
  }

  private replay(existing: Transfer, hash: string): CreatedTransfer {
    if (existing.requestHash !== hash) {
      throw new UnprocessableEntityException(
        'Idempotency-Key was already used for a different request',
      );
    }
    return { transfer: transferView(existing), replayed: true };
  }
}
