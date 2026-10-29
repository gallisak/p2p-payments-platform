import { IsUUID } from 'class-validator';

export class WalletOwnerQueryDto {
  @IsUUID()
  ownerId: string;
}
