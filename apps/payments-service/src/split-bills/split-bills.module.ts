import { Module } from '@nestjs/common';
import { SplitBillsController } from './split-bills.controller';
import { SplitBillsService } from './split-bills.service';
import { TransfersModule } from '../transfers/transfers.module';

@Module({
  imports: [TransfersModule],
  controllers: [SplitBillsController],
  providers: [SplitBillsService],
})
export class SplitBillsModule {}
