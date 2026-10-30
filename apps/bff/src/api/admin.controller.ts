import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { BlockWalletDto } from '../dto/money.dto';
import { PeriodQueryDto } from '../dto/query.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/admin')
export class AdminController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get('wallets/:id/events')
  async events(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'GET', `/admin/wallets/${id}/events`, { authorization }));
  }

  @Get('reconciliation')
  async reconciliation(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: PeriodQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(
      res,
      await this.upstream.request('ledger', 'GET', '/admin/reconciliation', {
        authorization,
        query: { from: query.from, to: query.to },
        slow: true,
      }),
    );
  }

  @Post('projections/rebuild')
  async rebuild(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('ledger', 'POST', '/admin/projections/rebuild', { authorization, slow: true }));
  }

  @Post('wallets/:id/block')
  async block(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BlockWalletDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'POST', `/admin/wallets/${id}/block`, { authorization, body: dto }));
  }

  @Post('wallets/:id/unblock')
  async unblock(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'POST', `/admin/wallets/${id}/unblock`, { authorization }));
  }
}
