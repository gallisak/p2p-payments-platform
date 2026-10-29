import { Module } from '@nestjs/common';
import { SplitBillsController } from './split-bills.controller';
import { SplitBillsService } from './split-bills.service';
import { SplitRemindersWorker } from './split-reminders.worker';
import { TransfersModule } from '../transfers/transfers.module';

@Module({
  imports: [TransfersModule],
  controllers: [SplitBillsController],
  providers: [SplitBillsService, SplitRemindersWorker],
})
export class SplitBillsModule {}
