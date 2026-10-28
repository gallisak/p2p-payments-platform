import { DataSource } from 'typeorm';
import { testDatabase } from './integration-app';

export default async function createTestDatabase(): Promise<void> {
  const { database, ...connection } = testDatabase;
  const admin = await new DataSource({
    type: 'postgres',
    ...connection,
    database: 'postgres',
  }).initialize();
  try {
    const rows: unknown[] = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [database],
    );
    if (rows.length === 0) {
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.destroy();
  }
}
