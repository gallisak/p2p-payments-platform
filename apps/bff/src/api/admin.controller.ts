import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { BlockWalletDto } from '../dto/money.dto';
import { PeriodQueryDto, TracesQueryDto } from '../dto/query.dto';
import { summarizeTraces } from '../traces/trace-summary';
import { UpstreamClient, UpstreamUnavailableError } from '../upstream/upstream.client';
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

  @Get('traces')
  async traces(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: TracesQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const access = await this.upstream.request('ledger', 'GET', '/admin/me', { authorization });
    if (access.status !== 200) {
      return relay(res, access);
    }
    const found = await this.upstream.request('jaeger', 'GET', '/api/traces', {
      query: { service: 'payments-service', operation: 'saga.check', lookback: '1h', limit: query.limit ?? '20' },
    });
    if (found.status !== 200) {
      throw new UpstreamUnavailableError('jaeger', `HTTP ${found.status}`);
    }
    return summarizeTraces(found.body);
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
