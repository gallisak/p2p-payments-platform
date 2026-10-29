import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsMoneyAmount } from '../../transfers/dto/is-money-amount.decorator';
import { Currency, SUPPORTED_CURRENCIES } from '../../common/currencies';

export const MAX_PARTICIPANTS = 50;

export class SplitParticipantDto {
  @IsString()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsMoneyAmount()
  amount?: number;
}

export class CreateSplitBillDto {
  @IsString()
  @Matches(/\S/, { message: 'title must not be blank' })
  @MaxLength(120)
  title: string;

  @IsIn(SUPPORTED_CURRENCIES)
  currency: Currency;

  @IsMoneyAmount()
  totalAmount: number;

  @IsISO8601({ strict: true })
  dueAt: string;

  @IsIn(['equal', 'custom'])
  split: 'equal' | 'custom';

  @IsOptional()
  @IsBoolean()
  includeCreator?: boolean;

  @ValidateNested({ each: true })
  @Type(() => SplitParticipantDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTICIPANTS)
  participants: SplitParticipantDto[];
}
