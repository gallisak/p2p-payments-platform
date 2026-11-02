import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { User } from '../src/auth/entities/user.entity';
import { applyTrustProxy } from '../src/common/trust-proxy';

process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';

describe('Login rate limits behind a proxy (e2e)', () => {
  let app: NestExpressApplication;
  const previous = { ip: process.env.LOGIN_IP_RATE_LIMIT_MAX, proxy: process.env.TRUST_PROXY };

  beforeEach(async () => {
    process.env.LOGIN_IP_RATE_LIMIT_MAX = '8';
    process.env.TRUST_PROXY = 'loopback';
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(getRepositoryToken(User))
      .useValue({ findOne: jest.fn(async () => null) })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    applyTrustProxy(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env.LOGIN_IP_RATE_LIMIT_MAX = previous.ip;
    process.env.TRUST_PROXY = previous.proxy;
  });

  const attempt = (email: string, ip: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password: 'wrong-password' });

  it('stops one client from locking a user out for everyone else', async () => {
    for (let i = 0; i < 5; i++) {
      await attempt('victim@example.com', '198.51.100.1').expect(401);
    }
    await attempt('victim@example.com', '198.51.100.1').expect(429);

    await attempt('victim@example.com', '198.51.100.2').expect(401);
  });

  it('limits one client trying a password across many accounts', async () => {
    for (let i = 0; i < 8; i++) {
      await attempt(`user-${i}@example.com`, '198.51.100.3').expect(401);
    }
    await attempt('user-9@example.com', '198.51.100.3').expect(429);

    await attempt('user-9@example.com', '198.51.100.4').expect(401);
  });

  it('ignores X-Forwarded-For from a client it does not trust', async () => {
    process.env.TRUST_PROXY = '';
    app.set('trust proxy', false);

    for (let i = 0; i < 5; i++) {
      await attempt('spoofer@example.com', `198.51.100.${10 + i}`).expect(401);
    }
    await attempt('spoofer@example.com', '198.51.100.50').expect(429);
  });
});
