import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('wallets')
@Index(['ownerId', 'currency'], { unique: true })
@Check('"balance" >= 0 AND "held" >= 0 AND "held" <= "balance"')
export class Wallet {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  ownerId: string;

  @Column()
  currency: string;

  @Column('numeric', { precision: 18, scale: 2, default: 0 })
  balance: string;

  @Column('numeric', { precision: 18, scale: 2, default: 0 })
  held: string;

  @Column('int', { default: 0 })
  version: number;
}
