import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { LedgerEvent } from './entities/ledger-event.entity';
import { EventStore } from './event-store.service';
import { AppendOnlyGuard } from './append-only.guard';

@Module({
  imports: [TypeOrmModule.forFeature([LedgerEvent, LedgerEntry])],
  providers: [EventStore, AppendOnlyGuard],
  exports: [EventStore],
})
export class LedgerModule {}
