import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../src/auth/auth.service';
import { User } from '../src/auth/entities/user.entity';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy';

describe('AuthService', () => {
  let service: AuthService;
  let usersRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (u) => ({ id: 'user-1', ...u })),
      create: jest.fn((u) => u),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        JwtService,
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    process.env.JWT_ACCESS_SECRET = 'test-access';
    process.env.JWT_REFRESH_SECRET = 'test-refresh';
  });

  it('registers a new user and returns a token pair', async () => {
    usersRepo.findOne.mockResolvedValueOnce(null);
    const result = await service.register({
      email: 'new@example.com',
      password: 'password123',
    });
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();
  });

  it('rejects registration with an already-used email', async () => {
    usersRepo.findOne.mockResolvedValueOnce({ id: 'user-1' });
    await expect(
      service.register({ email: 'dup@example.com', password: 'password123' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('refresh token rotation', () => {
    let now: number;

    beforeEach(async () => {
      const user = {
        id: 'user-1',
        email: 'a@example.com',
        role: 'user',
        passwordHash: await bcrypt.hash('password123', 10),
        refreshTokenHash: null,
      };
      // Як справжня БД: кожен запит отримує власну копію рядка.
      usersRepo.findOne.mockImplementation(async () => ({ ...user }));
      usersRepo.save.mockImplementation(async (u) => Object.assign(user, u));
      // Як UPDATE ... WHERE у Postgres: перевірка умови й запис — атомарно.
      usersRepo.update.mockImplementation(async (where, patch) => {
        const matches = Object.entries(where).every(
          ([key, value]) => user[key as keyof typeof user] === value,
        );
        if (matches) Object.assign(user, patch);
        return { affected: matches ? 1 : 0 };
      });
      now = Date.parse('2026-01-01T00:00:00Z');
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const login = () =>
      service.login({ email: 'a@example.com', password: 'password123' });

    it('rejects a refresh token that has already been rotated', async () => {
      const first = await login();
      now += 2000;
      const second = await service.refresh(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('accepts a refresh token only once under concurrent requests', async () => {
      const first = await login();
      const results = await Promise.allSettled([
        service.refresh(first.refreshToken),
        service.refresh(first.refreshToken),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
    });

    it('issues a distinct refresh token even within the same second', async () => {
      const first = await login();
      const second = await service.refresh(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  it('rejects login with a wrong password', async () => {
    usersRepo.findOne.mockResolvedValueOnce({
      id: 'user-1',
      email: 'a@example.com',
      passwordHash: await bcrypt.hash('correct-password', 10),
    });
    await expect(
      service.login({ email: 'a@example.com', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('JWT secrets', () => {
    // Без секрету в env код раніше підставляв загальновідомий 'change-me-…',
    // тож будь-хто міг підписати собі валідний токен.
    it('refuses to issue tokens when JWT_REFRESH_SECRET is not set', async () => {
      delete process.env.JWT_REFRESH_SECRET;
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.register({ email: 'new@example.com', password: 'password123' }),
      ).rejects.toThrow('JWT_REFRESH_SECRET');
    });

    it('refuses to issue tokens when JWT_ACCESS_SECRET is not set', async () => {
      delete process.env.JWT_ACCESS_SECRET;
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.register({ email: 'new@example.com', password: 'password123' }),
      ).rejects.toThrow('JWT_ACCESS_SECRET');
    });

    it('does not start JWT validation without JWT_ACCESS_SECRET', () => {
      delete process.env.JWT_ACCESS_SECRET;
      expect(() => new JwtStrategy()).toThrow('JWT_ACCESS_SECRET');
    });
  });
});
