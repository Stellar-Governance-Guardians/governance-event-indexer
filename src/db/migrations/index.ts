import { Migrator, type Kysely, type Migration, type MigrationProvider } from 'kysely';
import type { Database } from '../index.js';
import { up as init0001 } from './0001_init.js';

/**
 * Static migration registry. Deliberately not fs-scanning (FileMigrationProvider):
 * a static map is deterministic in `dist/` and under Vitest, and makes the
 * forward-only set reviewable in one place.
 *
 * Naming: `NNNN_snake_case` — append-only. Never edit an applied migration;
 * add a new one.
 */
const migrations: Record<string, Migration> = {
  '0001_init': { up: init0001 },
};

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export interface MigrationOutcome {
  /** Migration names applied by this call (empty when already current). */
  applied: string[];
}

/**
 * Apply all pending migrations to `latest`. Forward-only: this is the only
 * direction the CLI exposes. Fails loud: any error is rethrown with context.
 */
export async function runMigrations(db: Kysely<Database>): Promise<MigrationOutcome> {
  const migrator = new Migrator({ db, provider });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
  const failed = (results ?? []).filter((r) => r.status === 'Error');
  if (failed.length > 0) {
    throw new Error(
      `migration failed: ${failed.map((f) => `${f.migrationName} (${f.direction})`).join(', ')}`,
    );
  }
  return {
    applied: (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName),
  };
}
