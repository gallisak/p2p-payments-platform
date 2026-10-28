import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module';
import { User } from '../src/auth/entities/user.entity';

process.env.JWT_ACCESS_SECRET = 'test-access';
process.env.JWT_REFRESH_SECRET = 'test-refresh';

function inMemoryUsers() {
  const rows: User[] = [];
  return {
    findOne: jest.fn(async ({ where }: { where: Partial<User> }) =>
      rows.find((row) =>
        Object.entries(where).every(
          ([key, value]) => row[key as keyof User] === value,
        ),
      ) ?? null,
    ),
    create: jest.fn((user: User) => user),
    save: jest.fn(async (user: User) => {
      user.id ??= `user-${rows.length + 1}`;
      if (!rows.includes(user)) rows.push(user);
      return user;
    }),
  };
}

describe('Auth API (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule],
    })
      .overrideProvider(getRepositoryToken(User))
      .useValue(inMemoryUsers())
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('input validation', () => {
    it('rejects passwords longer than bcrypt can hash (72 bytes)', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'long@example.com', password: 'x'.repeat(73) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'cyr@example.com', password: 'пароль'.repeat(7) })
        .expect(400);
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'long@example.com', password: 'x'.repeat(10_000) })
        .expect(400);
    });

    it('accepts a password of exactly 72 bytes', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'edge@example.com', password: 'x'.repeat(72) })
        .expect(201);
    });
  });

  describe('login rate limiting', () => {
    const attempt = (email: string) =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'wrong-password' });

    it('blocks further attempts for an email after 5 failed logins', async () => {
      for (let i = 0; i < 5; i++) {
        await attempt('victim@example.com').expect(401);
      }
      await attempt('victim@example.com').expect(429);
    });

    it('does not block other users behind the same proxy IP', async () => {
      for (let i = 0; i < 6; i++) {
        await attempt('victim@example.com');
      }
      await attempt('someone-else@example.com').expect(401);
    });
  });
});
