import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { FailureReason, TransferStatus } from '../transfer-status';

@Entity('transfers')
@Index('UQ_transfers_idempotency', ['senderId', 'idempotencyKey'], { unique: true })
@Index('IDX_transfers_sender_created', ['senderId', 'createdAt'])
@Index('IDX_transfers_due', ['nextAttemptAt'], {
  where: `"status" NOT IN ('completed', 'failed')`,
})
export class Transfer {
  @PrimaryColumn('uuid')
  id: string;

  @Column('uuid')
  senderId: string;

  @Column('varchar', { length: 255 })
  idempotencyKey: string;

  @Column('char', { length: 64 })
  requestHash: string;

  @Column('uuid')
  fromWalletId: string;

  @Column('varchar', { length: 254 })
  recipientEmail: string;

  @Column('numeric', { precision: 18, scale: 2 })
  amount: string;

  @Column('varchar', { length: 3 })
  toCurrency: string;

  @Column('varchar', { length: 3, nullable: true })
  fromCurrency: string | null;

  @Column('uuid', { nullable: true })
  recipientId: string | null;

  @Column('uuid', { nullable: true })
  toWalletId: string | null;

  @Column('numeric', { precision: 18, scale: 2, nullable: true })
  creditAmount: string | null;

  @Column('numeric', { precision: 18, scale: 6, nullable: true })
  rate: string | null;

  @Column('timestamptz', { nullable: true })
  rateExpiresAt: Date | null;

  @Column('bigint', { nullable: true })
  limitCents: string | null;

  @Column('varchar', { length: 16 })
  status: TransferStatus;

  @Column('varchar', { length: 32, nullable: true })
  failureReason: FailureReason | null;

  @Column('text', { nullable: true })
  failureDetail: string | null;

  @Column('int', { default: 0 })
  attempts: number;

  @Column('boolean', { default: false })
  awaitingRetry: boolean;

  @Column('text', { nullable: true })
  lastError: string | null;

  @Column('timestamptz')
  nextAttemptAt: Date;

  @Column('timestamptz')
  deadlineAt: Date;

  @Column('int')
  version: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('timestamptz', { nullable: true })
  completedAt: Date | null;

  @Index('IDX_transfers_split_share')
  @Column('uuid', { nullable: true })
  splitShareId: string | null;

  @Column('varchar', { length: 64, nullable: true })
  traceContext: string | null;
}
