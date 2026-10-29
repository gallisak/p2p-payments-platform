import { IsUUID } from 'class-validator';

export class PayShareDto {
  @IsUUID()
  fromWalletId: string;
}
