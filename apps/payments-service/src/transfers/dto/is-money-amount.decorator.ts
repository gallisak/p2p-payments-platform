import { applyDecorators } from '@nestjs/common';
import { IsNumber, IsPositive, Max } from 'class-validator';
import { HasMaxTwoDecimals } from './has-max-two-decimals.decorator';
import { MAX_OPERATION_AMOUNT } from '../../common/currencies';

export function IsMoneyAmount(): PropertyDecorator {
  return applyDecorators(
    IsNumber(),
    HasMaxTwoDecimals(),
    IsPositive(),
    Max(MAX_OPERATION_AMOUNT),
  );
}
