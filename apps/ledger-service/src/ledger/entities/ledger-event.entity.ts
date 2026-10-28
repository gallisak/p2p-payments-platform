import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('ledger_events')
@Index(['streamId', 'streamVersion'], { unique: true })
export class LedgerEvent {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  position: string;

  @Index({ unique: true })
  @Column('uuid')
  eventId: string;

  @Column('uuid')
  streamId: string;

  @Column('int')
  streamVersion: number;

  @Column('varchar', { length: 64 })
  type: string;

  @Column('int')
  schemaVersion: number;

  @Column('jsonb')
  payload: Record<string, unknown>;

  @Column('jsonb', { default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  occurredAt: Date;
}
