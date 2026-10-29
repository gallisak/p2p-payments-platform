import { IsOptional, IsUUID } from 'class-validator';

export class ReleaseHoldDto {
  @IsOptional()
  @IsUUID()
  walletId?: string;
}
