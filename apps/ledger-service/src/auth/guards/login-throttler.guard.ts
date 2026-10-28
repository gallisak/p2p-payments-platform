import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: {
    ip?: string;
    body?: { email?: unknown };
  }): Promise<string> {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    return `${req.ip}:${email}`;
  }
}
