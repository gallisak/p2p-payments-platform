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

  @IsMoneyAmount()
  amount: number;

  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;
}
