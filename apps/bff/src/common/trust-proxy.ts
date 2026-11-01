import { NestExpressApplication } from '@nestjs/platform-express';

export function applyTrustProxy(app: NestExpressApplication): void {
  const value = process.env.TRUST_PROXY;
  if (value) {
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
  }
}
