import { sql, type Kysely } from 'kysely';
import type { Database } from '../index.js';

/**
 * 0001_init — schema bootstrap (I0 scaffold).
 *
 * Forward-only: there is no `down`. Migrations run through Kysely's Migrator
 * with a static registry (see ./index.ts) so the applied set is deterministic
 * in dist/ and under Vitest alike. Tested from an empty database in
 * tests/integration/migrations.test.ts.
 *
 * `indexer_meta` is a small key/value store for indexer bookkeeping that does
 * not belong to a single milestone (schema version, snapshot markers). The
 * ingest tables (raw_events, cursors, gaps) arrive with migration 0002 in I2;
 * decode tables with I3; reconciliation runs with I5.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE indexer_meta (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}
