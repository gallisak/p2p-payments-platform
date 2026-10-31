import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn('uuid')
  ownerId: string;

  @PrimaryColumn('varchar', { length: 255 })
  key: string;

  @Column('varchar', { length: 64 })
  requestHash: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
