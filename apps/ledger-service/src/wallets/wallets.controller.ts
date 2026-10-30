import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WalletsService } from './wallets.service';
import { DepositDto } from './dto/deposit.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';

interface AuthenticatedRequest {
  user: { userId: string; email: string; role: string };
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
  deposit(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() dto: DepositDto,
  ) {
    return this.wallets.deposit(id, req.user.userId, dto.amount);
  }

  @Post(':id/withdraw')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() dto: WithdrawDto,
  ) {
    return this.wallets.withdraw(id, req.user.userId, dto.amount);
  }
}
