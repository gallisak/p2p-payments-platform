import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import { PlaceHoldDto } from './dto/place-hold.dto';
import { CaptureHoldDto } from './dto/capture-hold.dto';
import { ResolveRecipientDto } from './dto/resolve-recipient.dto';
import { WalletOwnerQueryDto } from './dto/wallet-owner-query.dto';
import { ReleaseHoldDto } from './dto/release-hold.dto';
import { HoldsService } from '../wallets/holds.service';
import { WalletsService } from '../wallets/wallets.service';
import { AuthService } from '../auth/auth.service';

@ApiSecurity('internal-key')
@Controller('internal')
@UseGuards(InternalApiKeyGuard)
export class InternalController {
  constructor(
    private readonly holds: HoldsService,
    private readonly wallets: WalletsService,
    private readonly auth: AuthService,
  ) {}

  @Post('recipients')
  async resolveRecipient(@Body() dto: ResolveRecipientDto) {
    const userId = await this.auth.findUserIdByEmail(dto.email);
    if (!userId) {
      throw new NotFoundException('Отримувача не знайдено');
    }
    const wallet = await this.wallets.open(userId, dto.currency);
    return {
      walletId: wallet.id,
      ownerId: wallet.ownerId,
      currency: wallet.currency,
      blocked: wallet.blocked,
    };
  }

  @Get('wallets/:walletId')
  async wallet(
    @Param('walletId', ParseUUIDPipe) walletId: string,
    @Query() query: WalletOwnerQueryDto,
  ) {
    const wallet = await this.wallets.getById(walletId, query.ownerId);
    return {
      walletId: wallet.id,
      ownerId: wallet.ownerId,
      currency: wallet.currency,
      blocked: wallet.blocked,
    };
  }

  @Post('holds')
  place(@Body() dto: PlaceHoldDto) {
    return this.holds.place(dto);
  }

  @Post('holds/:holdId/release')
  release(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Body() dto: ReleaseHoldDto,
  ) {
    return this.holds.release(holdId, dto.walletId);
  }

  @Post('holds/:holdId/capture')
  capture(
    @Param('holdId', ParseUUIDPipe) holdId: string,
    @Body() dto: CaptureHoldDto,
  ) {
    return this.holds.capture(holdId, dto);
  }
}
