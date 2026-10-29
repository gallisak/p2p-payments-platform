import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { SplitBillsService } from './split-bills.service';
import { CreateSplitBillDto } from './dto/create-split-bill.dto';
import { PayShareDto } from './dto/pay-share.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { requireIdempotencyKey } from '../transfers/idempotency';
import { TransfersThrottlerGuard } from '../transfers/transfers-throttler.guard';

interface AuthedRequest {
  user: AuthUser;
}

@Controller('split-bills')
@UseGuards(JwtAuthGuard)
export class SplitBillsController {
  constructor(private readonly bills: SplitBillsService) {}

  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateSplitBillDto) {
    return this.bills.create(req.user, dto);
  }

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.bills.list(req.user.userId);
  }

  @Get(':id')
  get(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.bills.get(req.user.userId, id);
  }

  @Post(':id/shares/:shareId/pay')
  @UseGuards(TransfersThrottlerGuard)
  async pay(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('shareId', ParseUUIDPipe) shareId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: PayShareDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const { transfer, replayed } = await this.bills.payShare(req.user, id, shareId, key, dto);
    res.status(replayed ? HttpStatus.OK : HttpStatus.ACCEPTED);
    res.setHeader('Idempotent-Replayed', String(replayed));
    return transfer;
  }
}
