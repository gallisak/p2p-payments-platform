import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { isEmail } from 'class-validator';
import { User } from './entities/user.entity';
import { isUniqueViolation } from '../common/db-errors';
import { normalizeEmail } from './email';

@Injectable()
export class AdminSeeder implements OnApplicationBootstrap {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  async onApplicationBootstrap(): Promise<void> {
    const rawEmail = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (!rawEmail && !password) {
      return;
    }
    if (!rawEmail || !password) {
      throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
    }
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) {
      throw new Error(`ADMIN_EMAIL "${email}" is not a valid email address`);
    }
    const bytes = Buffer.byteLength(password, 'utf8');
    if (bytes < 8 || bytes > 72) {
      throw new Error('ADMIN_PASSWORD must be between 8 and 72 bytes');
    }
    if (await this.ensureAdmin(email)) {
      return;
    }
    try {
      await this.users.save(
        this.users.create({
          email,
          passwordHash: await bcrypt.hash(password, 10),
          role: 'admin',
        }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        throw err;
      }
      await this.ensureAdmin(email);
    }
  }

  private async ensureAdmin(email: string): Promise<boolean> {
    const existing = await this.users.findOne({ where: { email } });
    if (!existing) {
      return false;
    }
    if (existing.role !== 'admin') {
      throw new Error(
        `ADMIN_EMAIL ${email} belongs to a regular user; refusing to grant it admin rights`,
      );
    }
    return true;
  }
}
