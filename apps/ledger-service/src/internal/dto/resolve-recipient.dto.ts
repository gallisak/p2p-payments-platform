import { IsEmail, IsIn } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../../wallets/wallets.constants';

export class ResolveRecipientDto {
  @IsEmail()
  email: string;

  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;
}
