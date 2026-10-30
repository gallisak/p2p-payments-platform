import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { TransfersService } from './transfers.service';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { ListTransfersDto } from './dto/list-transfers.dto';
import { requireIdempotencyKey } from './idempotency';
import { TransfersThrottlerGuard } from './transfers-throttler.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';

interface AuthedRequest {
  user: AuthUser;
}

@ApiBearerAuth()
@Controller('transfers')
@UseGuards(JwtAuthGuard)
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @UseGuards(TransfersThrottlerGuard)
  async create(
    @Req() req: AuthedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = requireIdempotencyKey(idempotencyKey);
    const { transfer, replayed } = await this.transfers.create(req.user.userId, key, dto);
    res.status(replayed ? HttpStatus.OK : HttpStatus.ACCEPTED);
    res.setHeader('Idempotent-Replayed', String(replayed));
    return transfer;
  }

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: ListTransfersDto) {
    return this.transfers.list(req.user.userId, query.limit);
  }

  @Get(':id')
  getStatus(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.transfers.get(req.user.userId, id);
  }
}
