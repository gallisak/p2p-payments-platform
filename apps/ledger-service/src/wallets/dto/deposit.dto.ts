import { IsMoneyAmount } from './is-money-amount.decorator';

export class DepositDto {
  @IsMoneyAmount()
  amount: number;
}
