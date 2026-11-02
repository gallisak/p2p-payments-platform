import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsMoneyAmount } from './is-money-amount.decorator';
import { Currency, SUPPORTED_CURRENCIES } from '../../common/currencies';

export class CreateTransferDto {
  @IsUUID()
  fromWalletId: string;

  @IsString()
  @IsEmail()
  @MaxLength(254)
  toWalletIdentifier: string; // recipient email

  @ApiProperty({ description: "Amount debited, in the currency of the sender's wallet (fromWalletId)", example: 100 })
  @IsMoneyAmount()
  amount: number;

  @ApiProperty({
    description: "Recipient's currency. If it differs from the sender's wallet, the amount is converted at the current rate",
    enum: SUPPORTED_CURRENCIES,
    example: 'EUR',
  })
  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;
}
