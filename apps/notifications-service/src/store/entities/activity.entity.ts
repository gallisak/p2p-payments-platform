import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ActivityType } from '../../events/activity-types';

@Entity('activity')
@Index('UQ_activity_event_user', ['eventId', 'userId'], { unique: true })
@Index('IDX_activity_feed', ['userId', 'occurredAt', 'id'])
@Index('IDX_activity_feed_type', ['userId', 'type', 'occurredAt', 'id'])
export class Activity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column('uuid')
  userId: string;

  @Column('varchar', { length: 32 })
  type: ActivityType;

  @Column('uuid')
  eventId: string;

  @Column('timestamptz')
  occurredAt: Date;

  @Column('jsonb')
  data: Record<string, unknown>;
}
