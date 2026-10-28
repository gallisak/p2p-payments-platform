import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class BlockWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason: string;
}
