import { IsNumber, IsPositive, Max } from 'class-validator';
import { MAX_OPERATION_AMOUNT } from '../wallets.constants';
import { HasMaxTwoDecimals } from './has-max-two-decimals.decorator';

export class DepositDto {
  @IsNumber()
  @HasMaxTwoDecimals()
  @IsPositive()
  @Max(MAX_OPERATION_AMOUNT)
  amount: number;
}
