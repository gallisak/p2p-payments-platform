import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Upstream, UpstreamClient, UpstreamUnavailableError } from '../upstream/upstream.client';

export type Section<T = unknown> = { status: 'ok'; data: T } | { status: 'unavailable'; error: string };

const ERRORS: Record<Upstream, string> = {
  ledger: 'Гаманці тимчасово недоступні',
  payments: 'Перекази тимчасово недоступні',
  notifications: 'Стрічка активності тимчасово недоступна',
};

class Unauthorized extends Error {}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly upstream: UpstreamClient) {}

  @Get()
  async dashboard(@Headers('authorization') authorization: string | undefined) {
    if (!authorization) {
      throw new UnauthorizedException();
    }
    const section = async (upstream: Upstream, path: string, query?: Record<string, string>): Promise<Section> => {
      try {
        const res = await this.upstream.request(upstream, 'GET', path, { authorization, query });
        if (res.status === 401) {
          throw new Unauthorized();
        }
        if (res.status !== 200) {
          return { status: 'unavailable', error: ERRORS[upstream] };
        }
        return { status: 'ok', data: res.body };
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) {
          return { status: 'unavailable', error: ERRORS[upstream] };
        }
        throw err;
      }
    };
    const results = await Promise.allSettled([
      section('ledger', '/wallets'),
      section('payments', '/transfers', { limit: '10' }),
      section('notifications', '/activity', { limit: '20' }),
    ]);
    if (results.some((r) => r.status === 'rejected' && r.reason instanceof Unauthorized)) {
      throw new UnauthorizedException();
    }
    const [wallets, transfers, activity] = results.map((r) => {
      if (r.status === 'rejected') {
        throw r.reason;
      }
      return r.value;
    });
    return { wallets, transfers, activity };
  }
}
