import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { SplitBillsService } from './split-bills.service';
import { CreateSplitBillDto } from './dto/create-split-bill.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';

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
}
