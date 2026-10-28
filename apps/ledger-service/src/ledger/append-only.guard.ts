import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const APPEND_ONLY_TABLES = ['ledger_events', 'ledger_entries'];
const SCHEMA_LOCK_KEY = 7_340_001;

@Injectable()
export class AppendOnlyGuard implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      await manager.query(`
        CREATE OR REPLACE FUNCTION ledger_reject_modification() RETURNS trigger AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
        END;
        $$ LANGUAGE plpgsql
      `);
      for (const table of APPEND_ONLY_TABLES) {
        await manager.query(`
          CREATE OR REPLACE TRIGGER ${table}_no_update_delete
          BEFORE UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION ledger_reject_modification()
        `);
        await manager.query(`
          CREATE OR REPLACE TRIGGER ${table}_no_truncate
          BEFORE TRUNCATE ON ${table}
          FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_modification()
        `);
      }
    });
  }
}
