import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column('uuid')
  operationId: string;

  @Column('uuid')
  eventId: string;

  @Index()
  @Column('varchar', { length: 64 })
  accountId: string;

  @Column('varchar', { length: 3 })
  currency: string;

  @Column('numeric', { precision: 18, scale: 2 })
  amount: string;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
