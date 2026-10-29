import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ACTIVITY_TYPES, ActivityType } from '../events/activity-types';

export class ListActivityDto {
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').map((t) => t.trim()).filter(Boolean)
      : value,
  )
  @IsIn(ACTIVITY_TYPES, { each: true })
  type?: ActivityType[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
