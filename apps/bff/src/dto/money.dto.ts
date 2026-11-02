import { ApiProperty } from '@nestjs/swagger';
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

  @ApiProperty({ description: "Amount debited, in the currency of the sender's wallet (fromWalletId)", example: 100 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiProperty({
    description: "Recipient's currency. If it differs from the sender's wallet, the amount is converted at the current rate",
    enum: CURRENCIES,
    example: 'EUR',
  })
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
