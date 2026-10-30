import { IsIn, IsNumber, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';

export const CURRENCIES = ['USD', 'EUR', 'UAH'] as const;

export class OpenWalletDto {
  @IsIn(CURRENCIES)
  currency: string;
}

export class AmountDto {
  @IsNumber()
  @IsPositive()
  amount: number;
}

export class CreateTransferDto {
  @IsUUID()
  fromWalletId: string;

  @IsString()
  @MaxLength(254)
  toWalletIdentifier: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsIn(CURRENCIES)
  currency: string;
}

export class PayShareDto {
  @IsUUID()
  fromWalletId: string;
}

export class BlockWalletDto {
  @IsString()
  @MaxLength(500)
  reason: string;
}
