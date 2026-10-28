import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';

export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor() {
    const key = process.env.INTERNAL_API_KEY;
    if (!key) {
      throw new Error('INTERNAL_API_KEY is not set');
    }
    this.expected = digest(key);
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>()
      .headers[INTERNAL_API_KEY_HEADER];
    if (typeof header !== 'string' || !timingSafeEqual(digest(header), this.expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
