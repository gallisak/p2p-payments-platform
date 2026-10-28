import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { Wallet } from './entities/wallet.entity';

@Injectable()
export class WalletsService {
  constructor(
    @InjectRepository(Wallet) private readonly wallets: Repository<Wallet>,
  ) {}

  async getOrCreateForUser(userId: string, currency = 'USD'): Promise<Wallet> {
    let wallet = await this.wallets.findOne({ where: { ownerId: userId, currency } });
    if (!wallet) {
      wallet = await this.wallets.save(
        this.wallets.create({ ownerId: userId, currency, balance: '0' }),
      );
    }
    return wallet;
  }

  async listForUser(userId: string): Promise<Wallet[]> {
    return this.wallets.find({ where: { ownerId: userId } });
  }

  async getById(walletId: string, ownerId: string): Promise<Wallet> {
    const wallet = await this.wallets.findOne({
      where: { id: walletId, ownerId },
    });
    if (!wallet) {
      throw new NotFoundException('Гаманець не знайдено');
    }
    return wallet;
  }

  async deposit(
    walletId: string,
    ownerId: string,
    amount: number,
  ): Promise<Wallet> {
    const result = await this.wallets.increment(
      { id: walletId, ownerId },
      'balance',
      amount.toFixed(2),
    );
    if (!result.affected) {
      throw new NotFoundException('Гаманець не знайдено');
    }
    return this.getById(walletId, ownerId);
  }

  async withdraw(
    walletId: string,
    ownerId: string,
    amount: number,
  ): Promise<Wallet> {
    const value = amount.toFixed(2);
    const result = await this.wallets.decrement(
      { id: walletId, ownerId, balance: MoreThanOrEqual(value) },
      'balance',
      value,
    );
    if (!result.affected) {
      await this.getById(walletId, ownerId);
      throw new BadRequestException('Недостатньо коштів');
    }
    return this.getById(walletId, ownerId);
  }
}
