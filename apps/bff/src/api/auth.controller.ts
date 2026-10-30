import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CredentialsDto, RefreshDto } from '../dto/auth.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Post('register')
  async register(@Body() dto: CredentialsDto, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('ledger', 'POST', '/auth/register', { body: dto }));
  }

  @Post('login')
  async login(@Body() dto: CredentialsDto, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('ledger', 'POST', '/auth/login', { body: dto }));
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('ledger', 'POST', '/auth/refresh', { body: dto }));
  }
}
