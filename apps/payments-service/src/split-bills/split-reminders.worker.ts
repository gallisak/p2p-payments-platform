import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SplitBillsStore, billSummary } from './split-bills.store';
import { shareView } from './split-bill-view';
import { numberEnv } from '../common/env';

const BATCH = 100;

@Injectable()
export class SplitRemindersWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SplitRemindersWorker.name);
  private readonly intervalMs = numberEnv('SPLIT_REMINDER_INTERVAL_MS', 3_600_000);
  private readonly maxReminders = numberEnv('SPLIT_REMINDER_MAX', 3);
  private readonly pollMs = Math.max(100, numberEnv('SPLIT_REMINDER_POLL_MS', 60_000));
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly store: SplitBillsStore,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.SPLIT_REMINDERS_ENABLED === 'false') {
      return;
    }
    this.timer = setInterval(() => {
      if (!this.running) {
        this.running = this.runOnce()
          .then(() => undefined)
          .catch((err: Error) => this.logger.warn(`Split reminders failed: ${err.message}`))
          .finally(() => {
            this.running = undefined;
          });
      }
    }, this.pollMs);
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async runOnce(now = new Date()): Promise<number> {
    const due: { shareId: string; billId: string }[] = await this.dataSource.query(
      `SELECT s.id AS "shareId", s."billId" AS "billId"
         FROM split_shares s JOIN split_bills b ON b.id = s."billId"
        WHERE s.status = 'pending' AND b."dueAt" <= $1 AND s."reminderCount" < $2
          AND (s."lastRemindedAt" IS NULL OR s."lastRemindedAt" <= $1::timestamptz - make_interval(secs => $3))
        ORDER BY b."dueAt"
        LIMIT $4`,
      [now, this.maxReminders, this.intervalMs / 1000, BATCH],
    );
    let sent = 0;
    for (const { shareId, billId } of due) {
      const reminded = await this.dataSource.transaction(async (manager) => {
        const { bill, share } = await this.store.lock(manager, billId, shareId);
        if (
          !bill ||
          !share ||
          share.status !== 'pending' ||
          bill.dueAt > now ||
          share.reminderCount >= this.maxReminders ||
          (share.lastRemindedAt && share.lastRemindedAt.getTime() > now.getTime() - this.intervalMs)
        ) {
          return false;
        }
        share.reminderCount += 1;
        share.lastRemindedAt = now;
        await manager.save(share);
        bill.version += 1;
        await manager.save(bill);
        await this.store.emit(manager, 'SplitShareOverdue', bill, {
          bill: billSummary(bill),
          share: shareView(share),
        });
        return true;
      });
      if (reminded) {
        sent += 1;
      }
    }
    return sent;
  }
}
