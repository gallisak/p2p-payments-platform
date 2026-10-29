import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type SplitShareStatus = 'pending' | 'paying' | 'paid';

@Entity('split_shares')
@Index('UQ_split_shares_participant', ['billId', 'participantId'], { unique: true })
@Index('IDX_split_shares_participant', ['participantId'])
@Index('IDX_split_shares_unpaid', ['billId'], { where: `"status" = 'pending'` })
export class SplitShare {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  billId: string;

  @Column('uuid')
  participantId: string;

  @Column('varchar', { length: 254 })
  participantEmail: string;

  @Column('numeric', { precision: 18, scale: 2 })
  amount: string;

  @Column('varchar', { length: 16 })
  status: SplitShareStatus;

  @Column('uuid', { nullable: true })
  transferId: string | null;

  @Column('timestamptz', { nullable: true })
  paidAt: Date | null;

  @Column('int', { default: 0 })
  reminderCount: number;

  @Column('timestamptz', { nullable: true })
  lastRemindedAt: Date | null;
}
