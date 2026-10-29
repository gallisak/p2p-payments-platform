import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('transfer_snapshots')
@Index('IDX_transfer_snapshots_owner', ['ownerId', 'occurredAt'])
export class TransferSnapshot {
  @PrimaryColumn('uuid')
  transferId: string;

  @Column('uuid')
  ownerId: string;

  @Column('uuid', { nullable: true })
  recipientId: string | null;

  @Column('varchar', { length: 32 })
  status: string;

  @Column('jsonb')
  view: Record<string, unknown>;

  @Column('int')
  streamVersion: number;

  @Column('timestamptz')
  occurredAt: Date;
}
