import { Kysely, PostgresDialect, type ColumnType } from 'kysely';
import { Pool } from 'pg';

/**
 * Table interfaces for the indexer database. New tables land with their
 * migration in the milestone that introduces them (I2 ingestion, I3 decode,
 * I5 reconciliation). Migrations are forward-only and tested from empty.
 */
export interface IndexerMetaTable {
  key: string;
  /** JSON payload stored as jsonb. */
  value: ColumnType<unknown, string, string>;
  /** Default: now() in the database — omitted on insert. */
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface Database {
  indexer_meta: IndexerMetaTable;
}

export function createDatabase(databaseUrl: string): Kysely<Database> {
  const pool = new Pool({ connectionString: databaseUrl, max: 10 });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}

/** Run `fn` with a short-lived pool; always destroys the pool (no leaks). */
export async function withDatabase<T>(
  databaseUrl: string,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const db = createDatabase(databaseUrl);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}
