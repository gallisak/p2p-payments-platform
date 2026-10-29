import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type StepOutcome = 'succeeded' | 'retry' | 'failed';

@Entity('saga_steps')
@Index('IDX_saga_steps_transfer', ['transferId', 'id'])
export class SagaStep {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column('uuid')
  transferId: string;

  @Column('varchar', { length: 16 })
  step: string;

  @Column('varchar', { length: 16 })
  outcome: StepOutcome;

  @Column('timestamptz')
  startedAt: Date;

  @Column('int')
  durationMs: number;

  @Column('text', { nullable: true })
  error: string | null;
}
