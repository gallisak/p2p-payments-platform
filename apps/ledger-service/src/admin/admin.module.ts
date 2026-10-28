import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { ReconciliationService } from './reconciliation.service';
import { WalletsModule } from '../wallets/wallets.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [WalletsModule, LedgerModule],
  controllers: [AdminController],
  providers: [ReconciliationService],
})
export class AdminModule {}
