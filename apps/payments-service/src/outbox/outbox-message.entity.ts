import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { EventEnvelope } from './event-envelope';

@Entity('outbox')
@Index('IDX_outbox_unpublished', ['id'], { where: '"publishedAt" IS NULL' })
export class OutboxMessage {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index({ unique: true })
  @Column('uuid')
  eventId: string;

  @Column('varchar', { length: 64 })
  type: string;

  @Column('jsonb')
  envelope: EventEnvelope;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('timestamptz', { nullable: true })
  publishedAt: Date | null;

  @Column('int', { default: 0 })
  attempts: number;

  @Column('text', { nullable: true })
  lastError: string | null;
}
