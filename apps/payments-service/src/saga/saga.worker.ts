import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { LEDGER_CLIENT, LedgerPort } from '../ledger/ledger.client';
import { FxService } from '../fx/fx.service';
import { Transfer } from '../transfers/entities/transfer.entity';
import { STEP_BY_STATUS, Transition, TransferSaga } from './transfer-saga';
import { SagaStore } from './saga.store';
import { sagaPolicyFromEnv, sagaRuntimeFromEnv } from './saga-policy';

const MAX_IDLE_BACKOFF_MS = 5_000;

@Injectable()
export class SagaWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SagaWorker.name);
  private readonly runtime = sagaRuntimeFromEnv();
  private readonly saga: TransferSaga;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private kicked = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly store: SagaStore,
    @Inject(LEDGER_CLIENT) ledger: LedgerPort,
    fx: FxService,
  ) {
    this.saga = new TransferSaga(
      {
        ledger,
        quote: (from, to) => fx.quote(from, to),
        reserveDailyLimit: (transfer, limit, daily) =>
          this.store.reserveDailyLimit(transfer, limit, daily),
        now: () => new Date(),
      },
      sagaPolicyFromEnv(),
    );
  }

  get timeoutMs(): number {
    return this.runtime.timeoutMs;
  }

  onApplicationBootstrap(): void {
    if (process.env.SAGA_WORKER_ENABLED === 'false') {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  kick(): void {
    this.kicked = true;
    this.wake?.();
  }

  async runOnce(): Promise<number> {
    const due = await this.store.claimDue(new Date(), this.runtime.batchSize, this.runtime.leaseMs);
    await Promise.all(due.map((transfer) => this.advance(transfer)));
    return due.length;
  }

  private async advance(transfer: Transfer): Promise<void> {
    const step = STEP_BY_STATUS[transfer.status];
    if (!step) {
      return;
    }
    const startedAt = new Date();
    let transition: Transition;
    try {
      transition = await this.saga.step(transfer);
    } catch (err) {
      transition = { kind: 'retry', error: (err as Error).message, delayMs: this.runtime.pollMs };
    }
    try {
      const updated = await this.store.apply(transfer, transition, {
        step,
        startedAt,
        finishedAt: new Date(),
      });
      if (!updated) {
        this.logger.warn(`Transfer ${transfer.id} changed while ${step} ran; result discarded`);
      } else if (transition.kind === 'retry') {
        this.logger.warn(`Transfer ${transfer.id} ${step} will be retried: ${transition.error}`);
      }
    } catch (err) {
      this.logger.error(`Could not save ${step} of transfer ${transfer.id}: ${(err as Error).message}`);
    }
  }

  private async run(): Promise<void> {
    let backoff = this.runtime.pollMs;
    while (this.running) {
      this.kicked = false;
      const free = this.runtime.concurrency - this.inFlight.size;
      if (free > 0) {
        try {
          const due = await this.store.claimDue(
            new Date(),
            Math.min(free, this.runtime.batchSize),
            this.runtime.leaseMs,
          );
          backoff = this.runtime.pollMs;
          due.forEach((transfer) => this.track(this.advance(transfer)));
          if (due.length > 0) {
            continue;
          }
        } catch (err) {
          this.logger.warn(`Saga worker failed, retrying in ${backoff} ms: ${(err as Error).message}`);
          backoff = Math.min(backoff * 2, MAX_IDLE_BACKOFF_MS);
        }
      }
      if (!this.kicked) {
        await this.sleep(free > 0 ? backoff : this.runtime.pollMs);
      }
    }
    await Promise.all(this.inFlight);
  }

  private track(work: Promise<void>): void {
    const settled = work.catch((err: Error) => {
      this.logger.error(`Saga step crashed: ${err.message}`);
    });
    this.inFlight.add(settled);
    void settled.finally(() => {
      this.inFlight.delete(settled);
      this.kick();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
