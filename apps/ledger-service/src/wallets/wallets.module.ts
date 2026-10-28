import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { Wallet } from './entities/wallet.entity';
import { Hold } from './entities/hold.entity';
import { HoldsService } from './holds.service';
import { WalletLedger } from './wallet-ledger.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet, Hold]), LedgerModule],
  controllers: [WalletsController],
  providers: [WalletsService, WalletLedger, HoldsService],
  exports: [WalletsService, HoldsService],
})
export class WalletsModule {}
