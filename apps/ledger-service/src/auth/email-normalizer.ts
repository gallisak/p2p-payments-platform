import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const SCHEMA_LOCK_KEY = 7_340_001;

@Injectable()
export class EmailNormalizer implements OnModuleInit {
  private readonly logger = new Logger(EmailNormalizer.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const { normalized, conflicting } = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
      const [updated]: { count: number }[] = await manager.query(
        `WITH updated AS (
           UPDATE users u SET email = lower(btrim(u.email))
            WHERE u.email <> lower(btrim(u.email))
              AND NOT EXISTS (
                SELECT 1 FROM users o
                 WHERE o.id <> u.id AND lower(btrim(o.email)) = lower(btrim(u.email)))
           RETURNING u.id)
         SELECT count(*)::int AS count FROM updated`,
      );
      const [left]: { count: number }[] = await manager.query(
        `SELECT count(*)::int AS count FROM users WHERE email <> lower(btrim(email))`,
      );
      return { normalized: updated.count, conflicting: left.count };
    });
    if (normalized > 0) {
      this.logger.log(`Normalized ${normalized} email(s) to lowercase`);
    }
    if (conflicting > 0) {
      this.logger.warn(
        `${conflicting} email(s) differ from another account only by letter case and were left as is`,
      );
    }
  }
}
