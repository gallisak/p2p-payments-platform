import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { PayShareDto } from '../dto/money.dto';
import { CreateSplitBillDto } from '../dto/split-bill.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('split-bills')
@ApiBearerAuth()
@Controller('api/split-bills')
export class SplitBillsController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: CreateSplitBillDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('payments', 'POST', '/split-bills', { authorization, body: dto }));
  }

  @Get()
  async list(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('payments', 'GET', '/split-bills', { authorization }));
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('payments', 'GET', `/split-bills/${id}`, { authorization }));
  }

  @Post(':id/shares/:shareId/pay')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async pay(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('shareId', ParseUUIDPipe) shareId: string,
    @Body() dto: PayShareDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(
      res,
      await this.upstream.request('payments', 'POST', `/split-bills/${id}/shares/${shareId}/pay`, {
        authorization,
        idempotencyKey,
        body: dto,
      }),
    );
  }
}
