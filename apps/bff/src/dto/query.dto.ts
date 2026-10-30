import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ActivityQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

export class LimitQueryDto {
  @IsOptional()
  @Matches(/^\d{1,3}$/)
  limit?: string;
}

export class PeriodQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;
}
