import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThanOrEqual } from 'typeorm';
import { WalletsService } from '../src/wallets/wallets.service';
import { Wallet } from '../src/wallets/entities/wallet.entity';

describe('WalletsService', () => {
  let service: WalletsService;
  let walletsRepo: {
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    increment: jest.Mock;
    decrement: jest.Mock;
  };

  beforeEach(async () => {
    walletsRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (w) => w),
      create: jest.fn((w) => w),
      increment: jest.fn(),
      decrement: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        WalletsService,
        { provide: getRepositoryToken(Wallet), useValue: walletsRepo },
      ],
    }).compile();

    service = moduleRef.get(WalletsService);
  });

  it('increases balance on deposit', async () => {
    walletsRepo.increment.mockResolvedValueOnce({ affected: 1 });
    walletsRepo.findOne.mockResolvedValueOnce({
      id: 'wallet-1',
      balance: '150.00',
    });
    const result = await service.deposit('wallet-1', 'user-1', 50);
    expect(walletsRepo.increment).toHaveBeenCalledWith(
      { id: 'wallet-1', ownerId: 'user-1' },
      'balance',
      '50.00',
    );
    expect(result.balance).toBe('150.00');
  });

  it('does not allow withdrawing more than the current balance', async () => {
    walletsRepo.decrement.mockResolvedValueOnce({ affected: 0 });
    walletsRepo.findOne.mockResolvedValueOnce({
      id: 'wallet-1',
      balance: '100.00',
    });
    await expect(
      service.withdraw('wallet-1', 'user-1', 500),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(walletsRepo.decrement).toHaveBeenCalledWith(
      { id: 'wallet-1', ownerId: 'user-1', balance: MoreThanOrEqual('500.00') },
      'balance',
      '500.00',
    );
  });

  it("reports someone else's wallet as not found on withdraw", async () => {
    walletsRepo.decrement.mockResolvedValueOnce({ affected: 0 });
    walletsRepo.findOne.mockResolvedValueOnce(null);
    await expect(
      service.withdraw('wallet-1', 'user-2', 10),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
