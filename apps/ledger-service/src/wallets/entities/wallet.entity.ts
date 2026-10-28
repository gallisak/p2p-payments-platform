import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('wallets')
@Index(['ownerId', 'currency'], { unique: true })
export class Wallet {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  ownerId: string;

  @Column()
  currency: string;

  @Column('numeric', { precision: 18, scale: 2, default: 0 })
  balance: string;

  @Column('int', { default: 0 })
  version: number;
}
