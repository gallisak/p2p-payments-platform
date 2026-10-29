import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class TransfersThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: { ip?: string; user?: { userId?: string } }): Promise<string> {
    return req.user?.userId ?? `ip:${req.ip}`;
  }
}
