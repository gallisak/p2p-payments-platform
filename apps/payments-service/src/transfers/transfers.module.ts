import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';
import { Transfer } from './entities/transfer.entity';
import { SagaStep } from './entities/saga-step.entity';
import { SagaStore } from '../saga/saga.store';
import { SagaWorker } from '../saga/saga.worker';
import { LEDGER_CLIENT, LedgerClient } from '../ledger/ledger.client';
import { FxService } from '../fx/fx.service';
import { OutboxModule } from '../outbox/outbox.module';
import { numberEnv } from '../common/env';
import { SplitBillsStore } from '../split-bills/split-bills.store';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transfer, SagaStep]),
    ThrottlerModule.forRootAsync({
      useFactory: () => [
        {
          ttl: numberEnv('TRANSFER_RATE_LIMIT_TTL_MS', 60_000),
          limit: numberEnv('TRANSFER_RATE_LIMIT_MAX', 10),
        },
      ],
    }),
    OutboxModule,
  ],
  controllers: [TransfersController],
  providers: [
    TransfersService,
    SagaStore,
    SagaWorker,
    FxService,
    SplitBillsStore,
    { provide: LEDGER_CLIENT, useClass: LedgerClient },
  ],
  exports: [TransfersService, SplitBillsStore, LEDGER_CLIENT, ThrottlerModule],
})
export class TransfersModule {}
