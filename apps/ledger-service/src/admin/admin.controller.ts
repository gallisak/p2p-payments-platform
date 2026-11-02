import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { EventStore } from '../ledger/event-store.service';
import { LedgerEvent } from '../ledger/entities/ledger-event.entity';
import { StoredEvent } from '../ledger/ledger-events';
import { upcast } from '../ledger/upcasters';
import { WalletsService } from '../wallets/wallets.service';
import { ReconciliationService } from './reconciliation.service';
import { BlockWalletDto } from './dto/block-wallet.dto';
import { ReconciliationQueryDto } from './dto/reconciliation-query.dto';

interface AuthenticatedRequest {
  user: { userId: string };
}

function currentPayload(event: LedgerEvent): unknown {
  try {
    return upcast(event as unknown as StoredEvent).payload;
  } catch {
    return event.payload;
  }
}

@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventStore: EventStore,
    private readonly wallets: WalletsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('me')
  me() {
    return { role: 'admin' };
  }

  @Get('wallets/:id/events')
  async events(@Param('id', ParseUUIDPipe) id: string) {
    const events = await this.eventStore.readStream(this.dataSource.manager, id);
    if (events.length === 0) {
      throw new NotFoundException('Wallet not found');
    }
    return events.map((e) => ({
      position: e.position,
      eventId: e.eventId,
      streamVersion: e.streamVersion,
      type: e.type,
      schemaVersion: e.schemaVersion,
      payload: currentPayload(e),
      metadata: e.metadata,
      occurredAt: e.occurredAt,
    }));
  }

  @Get('reconciliation')
  reconcile(@Query() query: ReconciliationQueryDto) {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from >= to) {
      throw new BadRequestException('"from" must be earlier than "to"');
    }
    return this.reconciliation.reconcile({ from, to });
  }

  @Post('projections/rebuild')
  rebuild(@Request() req: AuthenticatedRequest) {
    return this.reconciliation.rebuild(req.user.userId);
  }

  @Post('wallets/:id/block')
  block(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() dto: BlockWalletDto,
  ) {
    return this.wallets.block(id, req.user.userId, dto.reason);
  }

  @Post('wallets/:id/unblock')
  unblock(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.wallets.unblock(id, req.user.userId);
  }
}
