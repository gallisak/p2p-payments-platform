import { IsIn } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../wallets.constants';

export class OpenWalletDto {
  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;
}
