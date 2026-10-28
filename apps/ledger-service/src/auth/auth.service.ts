import {
  ConflictException,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { requireJwtSecret } from './jwt-secrets';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  onModuleInit() {
    requireJwtSecret('JWT_ACCESS_SECRET');
    requireJwtSecret('JWT_REFRESH_SECRET');
  }

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.users.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email вже зареєстровано');
    }
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.users.save(
      this.users.create({ email: dto.email, passwordHash }),
    );
    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.users.findOne({ where: { email: dto.email } });
    if (!user) {
      throw new UnauthorizedException('Невірний email або пароль');
    }
    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Невірний email або пароль');
    }
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: { sub: string };
    try {
      payload = this.jwt.verify(refreshToken, {
        secret: requireJwtSecret('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Невалідний refresh token');
    }
    const user = await this.users.findOne({ where: { id: payload.sub } });
    if (!user || !user.refreshTokenHash) {
      throw new UnauthorizedException('Refresh token відкликано');
    }
    if (!this.matchesStoredHash(refreshToken, user.refreshTokenHash)) {
      throw new UnauthorizedException('Refresh token відкликано');
    }
    return this.issueTokens(user, user.refreshTokenHash);
  }

  private async issueTokens(
    user: User,
    previousHash?: string,
  ): Promise<TokenPair> {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload, {
      secret: requireJwtSecret('JWT_ACCESS_SECRET'),
      expiresIn: process.env.JWT_ACCESS_TTL ?? '15m',
    });
    const refreshToken = this.jwt.sign(payload, {
      secret: requireJwtSecret('JWT_REFRESH_SECRET'),
      expiresIn: process.env.JWT_REFRESH_TTL ?? '7d',
      jwtid: randomUUID(),
    });
    const refreshTokenHash = this.hashToken(refreshToken);
    if (previousHash === undefined) {
      user.refreshTokenHash = refreshTokenHash;
      await this.users.save(user);
    } else {
      const result = await this.users.update(
        { id: user.id, refreshTokenHash: previousHash },
        { refreshTokenHash },
      );
      if (result.affected !== 1) {
        throw new UnauthorizedException('Refresh token відкликано');
      }
    }
    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private matchesStoredHash(token: string, storedHash: string): boolean {
    const actual = Buffer.from(this.hashToken(token), 'hex');
    const expected = Buffer.from(storedHash, 'hex');
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
