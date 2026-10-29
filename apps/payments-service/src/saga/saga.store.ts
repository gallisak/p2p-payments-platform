import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Transfer } from '../transfers/entities/transfer.entity';
import { SagaStep, StepOutcome } from '../transfers/entities/saga-step.entity';
import { OutboxWriter, eventTypeFor } from '../outbox/outbox.writer';
import { SagaStepName, Transition } from './transfer-saga';

export interface StepTiming {
  step: SagaStepName;
  startedAt: Date;
  finishedAt: Date;
}

@Injectable()
export class SagaStore {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly outbox: OutboxWriter,
  ) {}

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<Transfer[]> {
    return this.dataSource.transaction(async (manager) => {
      const rows: { id: string }[] = await manager.query(
        `SELECT id FROM transfers
          WHERE status NOT IN ('completed', 'failed') AND "nextAttemptAt" <= $1
          ORDER BY "nextAttemptAt"
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) {
        return [];
      }
      const ids = rows.map((r) => r.id);
      await manager.update(
        Transfer,
        { id: In(ids) },
        { nextAttemptAt: new Date(now.getTime() + leaseMs), updatedAt: () => '"updatedAt"' },
      );
      return manager.find(Transfer, { where: { id: In(ids) } });
    });
  }

  async apply(
    claimed: Transfer,
    transition: Transition,
    timing: StepTiming,
  ): Promise<Transfer | null> {
    const { changes, outcome, error, emit } = this.changesFor(claimed, transition, timing.finishedAt);
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Transfer)
        .set({ ...changes, version: () => 'version + 1' })
        .where('id = :id AND version = :version', { id: claimed.id, version: claimed.version })
        .execute();
      if (result.affected !== 1) {
        return null;
      }
      const updated = await manager.findOneByOrFail(Transfer, { id: claimed.id });
      await manager.insert(SagaStep, {
        transferId: claimed.id,
        step: timing.step,
        outcome,
        startedAt: timing.startedAt,
        durationMs: timing.finishedAt.getTime() - timing.startedAt.getTime(),
        error,
      });
      if (emit) {
        await this.outbox.enqueue(manager, eventTypeFor(updated), updated);
      }
      return updated;
    });
  }

  async reserveDailyLimit(
    transfer: Transfer,
    limitCents: bigint,
    dailyLimitCents: bigint,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        transfer.senderId,
      ]);
      const [{ used }]: { used: string }[] = await manager.query(
        `SELECT COALESCE(SUM("limitCents"), 0)::text AS used FROM transfers
          WHERE "senderId" = $1 AND id <> $2 AND status <> 'failed'
            AND "createdAt" > $3::timestamptz - interval '24 hours'`,
        [transfer.senderId, transfer.id, transfer.createdAt],
      );
      if (BigInt(used) + limitCents > dailyLimitCents) {
        return false;
      }
      await manager.update(
        Transfer,
        { id: transfer.id },
        { limitCents: limitCents.toString(), updatedAt: () => '"updatedAt"' },
      );
      return true;
    });
  }

  private changesFor(
    claimed: Transfer,
    transition: Transition,
    now: Date,
  ): { changes: Partial<Transfer>; outcome: StepOutcome; error: string | null; emit: boolean } {
    const settled = { attempts: 0, awaitingRetry: false, lastError: null, nextAttemptAt: now };
    switch (transition.kind) {
      case 'advance':
        return {
          changes: { ...transition.patch, ...settled, status: transition.status },
          outcome: 'succeeded',
          error: null,
          emit: true,
        };
      case 'retry':
        return {
          changes: {
            attempts: claimed.attempts + 1,
            awaitingRetry: true,
            lastError: transition.error.slice(0, 1_000),
            nextAttemptAt: new Date(now.getTime() + transition.delayMs),
          },
          outcome: 'retry',
          error: transition.error.slice(0, 1_000),
          emit: !claimed.awaitingRetry,
        };
      case 'fail':
        return {
          changes: {
            ...settled,
            status: 'failed',
            failureReason: transition.reason,
            failureDetail: transition.detail.slice(0, 1_000),
            completedAt: now,
          },
          outcome: 'failed',
          error: transition.detail.slice(0, 1_000),
          emit: true,
        };
      case 'compensate':
        return {
          changes: {
            ...settled,
            status: 'compensating',
            failureReason: transition.reason,
            failureDetail: transition.detail.slice(0, 1_000),
          },
          outcome: 'failed',
          error: transition.detail.slice(0, 1_000),
          emit: true,
        };
    }
  }
}
