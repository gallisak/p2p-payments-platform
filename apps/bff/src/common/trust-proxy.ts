import { NestExpressApplication } from '@nestjs/platform-express';
import { createHash, timingSafeEqual } from 'crypto';
import { NextFunction, Request, Response } from 'express';

export const PROXY_SECRET_HEADER = 'x-proxy-secret';

const digest = (value: string) => createHash('sha256').update(value).digest();

export function applyTrustProxy(app: NestExpressApplication): void {
  const value = process.env.TRUST_PROXY;
  if (value) {
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
  }
  const secret = process.env.PROXY_SECRET;
  if (secret) {
    const expected = digest(secret);
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const header = req.headers[PROXY_SECRET_HEADER];
      if (typeof header !== 'string' || !timingSafeEqual(digest(header), expected)) {
        delete req.headers['x-forwarded-for'];
      }
      next();
    });
  }
}
