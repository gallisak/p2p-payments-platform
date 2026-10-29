import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('processed_events')
export class ProcessedEvent {
  @PrimaryColumn('uuid')
  eventId: string;

  @Column('varchar', { length: 16 })
  source: string;

  @Index()
  @Column('timestamptz', { default: () => 'now()' })
  processedAt: Date;
}
