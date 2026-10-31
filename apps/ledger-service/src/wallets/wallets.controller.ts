import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletOperation, WalletsService } from './wallets.service';
import { DepositDto } from './dto/deposit.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { optionalIdempotencyKey } from '../common/idempotency';

interface AuthenticatedRequest {
  user: { userId: string; email: string; role: string };
}

function respond(res: Response, { wallet, replayed }: WalletOperation) {
  res.status(replayed ? HttpStatus.OK : HttpStatus.CREATED);
  res.setHeader('Idempotent-Replayed', String(replayed));
  return wallet;
}

@ApiBearerAuth()
@Controller('wallets')
@UseGuards(JwtAuthGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get()
  list(@Request() req: AuthenticatedRequest) {
    return this.wallets.listForUser(req.user.userId);
  }

  @Post()
  open(@Request() req: AuthenticatedRequest, @Body() dto: OpenWalletDto) {
    return this.wallets.open(req.user.userId, dto.currency);
  }

  @Get(':id')
  getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    return this.wallets.getById(id, req.user.userId);
  }

  @Post(':id/deposit')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  async deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: DepositDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = optionalIdempotencyKey(idempotencyKey);
    return respond(res, await this.wallets.deposit(id, req.user.userId, dto.amount, key));
  }

  @Post(':id/withdraw')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  async withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: WithdrawDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = optionalIdempotencyKey(idempotencyKey);
    return respond(res, await this.wallets.withdraw(id, req.user.userId, dto.amount, key));
  }
}
