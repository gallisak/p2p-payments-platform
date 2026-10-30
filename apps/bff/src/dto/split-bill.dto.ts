import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CURRENCIES } from './money.dto';

export class SplitParticipantDto {
  @IsString()
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;
}

export class CreateSplitBillDto {
  @IsString()
  @MaxLength(120)
  title: string;

  @IsIn(CURRENCIES)
  currency: string;

  @IsNumber()
  @IsPositive()
  totalAmount: number;

  @IsString()
  dueAt: string;

  @IsIn(['equal', 'custom'])
  split: string;

  @IsOptional()
  @IsBoolean()
  includeCreator?: boolean;

  @ValidateNested({ each: true })
  @Type(() => SplitParticipantDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  participants: SplitParticipantDto[];
}
