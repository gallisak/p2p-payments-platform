import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type HoldStatus = 'placed' | 'released' | 'captured' | 'voided';

@Entity('holds')
export class Hold {
  @PrimaryColumn('uuid')
  id: string;

  @Index()
  @Column('uuid')
  walletId: string;

  @Column('numeric', { precision: 18, scale: 2 })
  amount: string;

  @Column()
  currency: string;

  @Column('varchar', { length: 16 })
  status: HoldStatus;

  @Column('uuid', { nullable: true })
  toWalletId: string | null;

  @Column('numeric', { precision: 18, scale: 2, nullable: true })
  creditAmount: string | null;

  @Column('varchar', { nullable: true })
  creditCurrency: string | null;

  @Column('uuid', { nullable: true })
  operationId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
