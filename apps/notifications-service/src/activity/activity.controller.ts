import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { InvalidCursorError, NotificationsStore } from '../store/notifications.store';
import { ListActivityDto } from './list-activity.dto';

interface AuthedRequest {
  user: AuthUser;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class ActivityController {
  constructor(private readonly store: NotificationsStore) {}

  @Get('activity')
  async list(@Req() req: AuthedRequest, @Query() query: ListActivityDto) {
    try {
      return await this.store.activity(req.user.userId, {
        types: query.type,
        cursor: query.cursor,
        limit: query.limit ?? 20,
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Get('snapshot')
  snapshot(@Req() req: AuthedRequest) {
    return this.store.snapshot(req.user.userId);
  }
}
