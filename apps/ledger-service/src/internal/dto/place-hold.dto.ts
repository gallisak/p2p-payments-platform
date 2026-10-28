import { IsUUID } from 'class-validator';
import { IsMoneyAmount } from '../../wallets/dto/is-money-amount.decorator';

export class PlaceHoldDto {
  @IsUUID()
  holdId: string;

  @IsUUID()
  walletId: string;

  @IsUUID()
  ownerId: string;

  @IsMoneyAmount()
  amount: number;
}
