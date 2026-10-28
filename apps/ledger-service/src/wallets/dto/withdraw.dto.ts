import { IsMoneyAmount } from './is-money-amount.decorator';

export class WithdrawDto {
  @IsMoneyAmount()
  amount: number;
}
