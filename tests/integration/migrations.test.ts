import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { withDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { withTempDatabase } from './helpers/db.js';

/**
 * Charter: migrations are forward-only and tested FROM EMPTY (I3 rule,
 * enforced from day one). Offline w.r.t. the testnet — only local Postgres.
 */
describe('migrations', () => {
  it('applies from an empty database and is idempotent', async () => {
    await withTempDatabase(async (url) => {
      const first = await withDatabase(url, (db) => runMigrations(db));
      expect(first.applied).toEqual(['0001_init', '0002_ingest']);

      const second = await withDatabase(url, (db) => runMigrations(db));
      expect(second.applied).toEqual([]);
    });
  });

  it('creates the expected schema shape', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, (db) => runMigrations(db));

      await withDatabase(url, async (db) => {
        const tables = await sql<{ table_name: string }>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name NOT LIKE 'kysely%'
        `.execute(db);
        expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
          'indexer_meta',
          'ingest_cursors',
          'ingest_gaps',
          'raw_events',
        ]);
      });
    });
  });

  it('round-trips a row through the typed Kysely API', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await runMigrations(db);
        await db
          .insertInto('indexer_meta')
          .values({ key: 'schema_version', value: JSON.stringify({ v: 1 }) })
          .execute();

        const row = await db
          .selectFrom('indexer_meta')
          .selectAll()
          .where('key', '=', 'schema_version')
          .executeTakeFirstOrThrow();
        expect(row.key).toBe('schema_version');
        expect(row.value).toEqual({ v: 1 });
        expect(row.updated_at).toBeInstanceOf(Date);
      });
    });
  });
});
