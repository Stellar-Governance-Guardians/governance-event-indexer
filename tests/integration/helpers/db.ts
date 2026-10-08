import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/**
 * Integration-test helper: run `fn` against a throwaway database created next
 * to $DATABASE_URL, then drop it. This keeps "migrations from empty" honest —
 * every run starts from a database with no tables at all.
 *
 * Requires a Postgres superuser-ish URL (the docker-compose / CI service
 * user is one). Fails loud if DATABASE_URL is missing: no silent skips.
 */
export async function withTempDatabase(fn: (url: string) => Promise<void>): Promise<void> {
  const base = process.env['DATABASE_URL'];
  if (base === undefined || base === '') {
    throw new Error(
      'DATABASE_URL is not set. Start Postgres first: docker compose up -d postgres ' +
        '(CI provides a postgres:16 service container).',
    );
  }

  const target = new URL(base);
  const dbName = `itest_${randomBytes(6).toString('hex')}`;

  const adminUrl = new URL(target.toString());
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });

  // DROP ... WITH (FORCE) kills backends mid-flight if a pool socket is still
  // closing; the client then surfaces a 57P01 FATAL as an unhandled error.
  // Wait (bounded, fail loud) until no backend is attached to the temp DB.
  const waitForCleanTeardown = async (): Promise<void> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [dbName],
      );
      const n = rows[0]?.n ?? 0;
      if (n === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`teardown: ${n} backend(s) still connected to ${dbName} after 5s`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  try {
    // dbName is [a-z0-9_] only, but quote it anyway — identifiers are never
    // interpolated unquoted in this codebase.
    await admin.query(`CREATE DATABASE "${dbName}"`);
    target.pathname = `/${dbName}`;
    try {
      await fn(target.toString());
    } finally {
      await waitForCleanTeardown();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}
