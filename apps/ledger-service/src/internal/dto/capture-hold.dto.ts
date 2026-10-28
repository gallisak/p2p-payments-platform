import { IsIn, IsUUID } from 'class-validator';
import { IsMoneyAmount } from '../../wallets/dto/is-money-amount.decorator';
import { Currency, SUPPORTED_CURRENCIES } from '../../wallets/wallets.constants';

export class CaptureHoldDto {
  @IsUUID()
  toWalletId: string;

  @IsMoneyAmount()
  amount: number;

  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;
}
