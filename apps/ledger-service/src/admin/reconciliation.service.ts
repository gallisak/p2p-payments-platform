import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Wallet } from '../wallets/entities/wallet.entity';
import { LedgerEvent } from '../ledger/entities/ledger-event.entity';
import { StoredEvent } from '../ledger/ledger-events';
import { formatCents, toCents } from '../ledger/money';
import { StreamCheck, checkStream } from '../ledger/stream-check';

const BATCH_SIZE = 500;

export interface Period {
  from?: Date;
  to?: Date;
}

interface ProjectionView {
  balance: string;
  held: string;
  blocked: boolean;
  version: number;
}

export interface ProjectionMismatch {
  walletId: string;
  stored: ProjectionView | null;
  rebuilt: ProjectionView;
  placedHolds: string;
  issues: string[];
}

function toStored(event: LedgerEvent): StoredEvent {
  return {
    type: event.type,
    schemaVersion: event.schemaVersion,
    streamVersion: event.streamVersion,
    payload: event.payload,
  } as unknown as StoredEvent;
}

function rebuiltView(check: StreamCheck): ProjectionView {
  return {
    balance: formatCents(check.state.balance),
    held: formatCents(check.state.held),
    blocked: check.state.blocked,
    version: check.version,
  };
}

function storedView(wallet: Wallet): ProjectionView {
  return {
    balance: wallet.balance,
    held: wallet.held,
    blocked: wallet.blocked,
    version: wallet.version,
  };
}

@Injectable()
export class ReconciliationService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async reconcile(period: Period) {
    const { totals, unbalancedOperations, projections } = await this.snapshot(
      async (manager) => ({
        totals: await this.totals(manager, period),
        unbalancedOperations: await this.unbalancedOperations(manager, period),
        projections: await this.checkProjections(manager),
      }),
    );
    const ok =
      totals.every((t) => t.net === '0.00') &&
      unbalancedOperations.length === 0 &&
      projections.mismatches.length === 0;
    return {
      ok,
      period: {
        from: period.from?.toISOString() ?? null,
        to: period.to?.toISOString() ?? null,
      },
      totals,
      unbalancedOperations,
      projections,
    };
  }

  async rebuild() {
    const { mismatches } = await this.snapshot((manager) =>
      this.checkProjections(manager),
    );
    const rebuilt: string[] = [];
    const skipped: { walletId: string; issues: string[] }[] = [];
    for (const { walletId } of mismatches) {
      const issues = await this.dataSource.transaction(async (manager) => {
        const wallet = await manager.findOne(Wallet, {
          where: { id: walletId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!wallet) {
          return ['no projection row to rebuild'];
        }
        const check = checkStream(await this.streamOf(manager, walletId));
        if (check.issues.length > 0) {
          return check.issues;
        }
        wallet.balance = formatCents(check.state.balance);
        wallet.held = formatCents(check.state.held);
        wallet.blocked = check.state.blocked;
        wallet.version = check.version;
        await manager.save(wallet);
        return [];
      });
      if (issues.length > 0) {
        skipped.push({ walletId, issues });
      } else {
        rebuilt.push(walletId);
      }
    }
    return { rebuilt, skipped };
  }

  private snapshot<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      await manager.query('SET TRANSACTION READ ONLY');
      return work(manager);
    });
  }

  private async totals(manager: EntityManager, period: Period) {
    const { clause, params } = this.periodClause(period);
    const rows: {
      currency: string;
      debits: string;
      credits: string;
      net: string;
      operations: string;
    }[] = await manager.query(
      `SELECT currency,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0), 0)::text AS debits,
              COALESCE(SUM(amount) FILTER (WHERE amount > 0), 0)::text AS credits,
              SUM(amount)::text AS net,
              COUNT(DISTINCT "operationId")::text AS operations
         FROM ledger_entries ${clause}
        GROUP BY currency
        ORDER BY currency`,
      params,
    );
    return rows.map((r) => ({
      currency: r.currency,
      debits: formatCents(toCents(r.debits)),
      credits: formatCents(toCents(r.credits)),
      net: formatCents(toCents(r.net)),
      operations: Number(r.operations),
    }));
  }

  private async unbalancedOperations(manager: EntityManager, period: Period) {
    const { clause, params } = this.periodClause(period);
    const rows: { operationId: string; currency: string; total: string }[] =
      await manager.query(
        `SELECT "operationId", currency, SUM(amount)::text AS total
           FROM ledger_entries ${clause}
          GROUP BY "operationId", currency
         HAVING SUM(amount) <> 0
          ORDER BY "operationId", currency`,
        params,
      );
    return rows.map((r) => ({ ...r, total: formatCents(toCents(r.total)) }));
  }

  private async checkProjections(manager: EntityManager) {
    const placedRows: { walletId: string; total: string }[] =
      await manager.query(
        `SELECT "walletId", SUM(amount)::text AS total
           FROM holds WHERE status = 'placed' GROUP BY "walletId"`,
      );
    const placed = new Map(placedRows.map((r) => [r.walletId, toCents(r.total)]));
    const mismatches: ProjectionMismatch[] = [];
    let checked = 0;
    let after = '00000000-0000-0000-0000-000000000000';

    for (;;) {
      const page: { streamId: string }[] = await manager.query(
        `SELECT DISTINCT "streamId" FROM ledger_events
          WHERE "streamId" > $1 ORDER BY "streamId" LIMIT $2`,
        [after, BATCH_SIZE],
      );
      if (page.length === 0) {
        break;
      }
      const streamIds = page.map((r) => r.streamId);
      after = streamIds[streamIds.length - 1];
      checked += streamIds.length;

      const wallets = await manager.findBy(Wallet, { id: In(streamIds) });
      const events = await manager.find(LedgerEvent, {
        where: { streamId: In(streamIds) },
        order: { streamId: 'ASC', streamVersion: 'ASC' },
      });
      const walletsById = new Map(wallets.map((w) => [w.id, w]));
      const eventsByStream = new Map<string, StoredEvent[]>();
      for (const event of events) {
        const list = eventsByStream.get(event.streamId) ?? [];
        list.push(toStored(event));
        eventsByStream.set(event.streamId, list);
      }

      for (const streamId of streamIds) {
        const check = checkStream(eventsByStream.get(streamId) ?? []);
        const wallet = walletsById.get(streamId);
        const placedHolds = placed.get(streamId) ?? 0n;
        const issues = [...check.issues];
        if (!wallet) {
          issues.push('events exist but the wallet projection is missing');
        } else {
          if (toCents(wallet.balance) !== check.state.balance) {
            issues.push('balance differs from the event log');
          }
          if (toCents(wallet.held) !== check.state.held) {
            issues.push('held differs from the event log');
          }
          if (wallet.blocked !== check.state.blocked) {
            issues.push('blocked flag differs from the event log');
          }
          if (wallet.version !== check.version) {
            issues.push('version differs from the event log');
          }
        }
        if (check.state.held !== placedHolds) {
          issues.push('held in the event log differs from the sum of placed holds');
        }
        if (issues.length > 0) {
          mismatches.push({
            walletId: streamId,
            stored: wallet ? storedView(wallet) : null,
            rebuilt: rebuiltView(check),
            placedHolds: formatCents(placedHolds),
            issues,
          });
        }
      }
    }

    const orphans = await manager
      .getRepository(Wallet)
      .createQueryBuilder('w')
      .where(
        'NOT EXISTS (SELECT 1 FROM ledger_events e WHERE e."streamId" = w.id)',
      )
      .getMany();
    for (const wallet of orphans) {
      mismatches.push({
        walletId: wallet.id,
        stored: storedView(wallet),
        rebuilt: rebuiltView(checkStream([])),
        placedHolds: formatCents(placed.get(wallet.id) ?? 0n),
        issues: ['wallet projection has no events'],
      });
    }

    return { scope: 'all wallets', checked, mismatches };
  }

  private async streamOf(
    manager: EntityManager,
    streamId: string,
  ): Promise<StoredEvent[]> {
    const events = await manager.find(LedgerEvent, {
      where: { streamId },
      order: { streamVersion: 'ASC' },
    });
    return events.map(toStored);
  }

  private periodClause(period: Period): { clause: string; params: Date[] } {
    const conditions: string[] = [];
    const params: Date[] = [];
    if (period.from) {
      params.push(period.from);
      conditions.push(`"createdAt" >= $${params.length}`);
    }
    if (period.to) {
      params.push(period.to);
      conditions.push(`"createdAt" < $${params.length}`);
    }
    return {
      clause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
      params,
    };
  }
}
