import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTransferDto } from '../src/transfers/dto/create-transfer.dto';

describe('CreateTransferDto', () => {
  const valid = {
    fromWalletId: '3f1c2a6e-8b4d-4c1e-9f2a-7d5b6c8e9a01',
    toWalletIdentifier: 'bob@example.com',
    amount: 25,
    currency: 'USD',
  };

  async function errorsFor(payload: Record<string, unknown>) {
    const errors = await validate(plainToInstance(CreateTransferDto, payload));
    return errors.map((e) => e.property);
  }

  it('accepts a well-formed transfer', async () => {
    expect(await errorsFor(valid)).toEqual([]);
  });

  it('rejects a non-UUID source wallet', async () => {
    expect(await errorsFor({ ...valid, fromWalletId: 'wallet-1' })).toEqual([
      'fromWalletId',
    ]);
  });

  it('rejects zero and negative amounts', async () => {
    expect(await errorsFor({ ...valid, amount: 0 })).toEqual(['amount']);
    expect(await errorsFor({ ...valid, amount: -10 })).toEqual(['amount']);
  });

  it('rejects a missing recipient', async () => {
    const payload: Partial<typeof valid> = { ...valid };
    delete payload.toWalletIdentifier;
    expect(await errorsFor(payload)).toEqual(['toWalletIdentifier']);
  });
});
