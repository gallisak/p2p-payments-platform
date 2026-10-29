import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type SplitBillStatus = 'pending' | 'partially_paid' | 'settled';

@Entity('split_bills')
@Index('IDX_split_bills_creator', ['creatorId', 'createdAt'])
@Index('IDX_split_bills_due', ['dueAt'])
export class SplitBill {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  creatorId: string;

  @Column('varchar', { length: 254 })
  creatorEmail: string;

  @Column('varchar', { length: 120 })
  title: string;

  @Column('varchar', { length: 3 })
  currency: string;

  @Column('numeric', { precision: 18, scale: 2 })
  totalAmount: string;

  @Column('numeric', { precision: 18, scale: 2 })
  creatorAmount: string;

  @Column('varchar', { length: 8 })
  splitMode: 'equal' | 'custom';

  @Column('timestamptz')
  dueAt: Date;

  @Column('varchar', { length: 16 })
  status: SplitBillStatus;

  @Column('int')
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('timestamptz', { nullable: true })
  settledAt: Date | null;
}
