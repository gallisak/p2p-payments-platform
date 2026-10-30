import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CreateTransferDto } from '../dto/money.dto';
import { LimitQueryDto } from '../dto/query.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('transfers')
@ApiBearerAuth()
@Controller('api/transfers')
export class TransfersController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(
      res,
      await this.upstream.request('payments', 'POST', '/transfers', { authorization, idempotencyKey, body: dto }),
    );
  }

  @Get()
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: LimitQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('payments', 'GET', '/transfers', { authorization, query: { limit: query.limit } }));
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('payments', 'GET', `/transfers/${id}`, { authorization }));
  }
}
