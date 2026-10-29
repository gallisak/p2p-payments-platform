import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('wallet_snapshots')
export class WalletSnapshot {
  @PrimaryColumn('uuid')
  walletId: string;

  @Index()
  @Column('uuid')
  ownerId: string;

  @Column('varchar', { length: 3 })
  currency: string;

  @Column('numeric', { precision: 18, scale: 2 })
  balance: string;

  @Column('numeric', { precision: 18, scale: 2 })
  held: string;

  @Column('boolean')
  blocked: boolean;

  @Column('int')
  streamVersion: number;

  @Column('timestamptz')
  occurredAt: Date;
}
