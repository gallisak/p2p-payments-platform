import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AmountDto, OpenWalletDto } from '../dto/money.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('wallets')
@ApiBearerAuth()
@Controller('api/wallets')
export class WalletsController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get()
  async list(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('ledger', 'GET', '/wallets', { authorization }));
  }

  @Post()
  async open(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: OpenWalletDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'POST', '/wallets', { authorization, body: dto }));
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'GET', `/wallets/${id}`, { authorization }));
  }

  @Post(':id/deposit')
  async deposit(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'POST', `/wallets/${id}/deposit`, { authorization, body: dto }));
  }

  @Post(':id/withdraw')
  async withdraw(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(res, await this.upstream.request('ledger', 'POST', `/wallets/${id}/withdraw`, { authorization, body: dto }));
  }
}
