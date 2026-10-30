import { Controller, Get, Headers, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ActivityQueryDto } from '../dto/query.dto';
import { UpstreamClient } from '../upstream/upstream.client';
import { relay } from '../upstream/relay';

@ApiTags('activity')
@ApiBearerAuth()
@Controller('api')
export class ActivityController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get('activity')
  async list(
    @Headers('authorization') authorization: string | undefined,
    @Query() query: ActivityQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return relay(
      res,
      await this.upstream.request('notifications', 'GET', '/activity', {
        authorization,
        query: { type: query.type, cursor: query.cursor, limit: query.limit },
      }),
    );
  }

  @Get('snapshot')
  async snapshot(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response) {
    return relay(res, await this.upstream.request('notifications', 'GET', '/snapshot', { authorization }));
  }
}
