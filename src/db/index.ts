import { Kysely, PostgresDialect, type ColumnType } from 'kysely';
import { Pool, types } from 'pg';

// int8 (bigint) -> JS number. Ledger ranges, op/event indexes and cursors are
// far below 2^53 (ledgers are ~5e6; windows are 1000). 128-bit governance
// VALUES are numeric(39,0), a different OID (1700), and intentionally keep
// arriving as lossless decimal strings.
types.setTypeParser(20, (v: string) => Number(v));

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

/** Where a raw event row came from. Live and replay rows never mix silently. */
export type EventSource = 'live' | 'fixture-replay';

export interface RawEventsTable {
  ledger: number;
  tx_hash: string;
  op_index: number;
  event_index: number;
  contract_id: string;
  event_type: string;
  /** null only if the RPC omitted it (validated in normalize). */
  ledger_closed_at: Date | null;
  /** JSON array of base64 ScVal topics: stringified on insert, parsed by pg on select. */
  topics: ColumnType<unknown, string, string>;
  value: string;
  in_successful_contract_call: boolean;
  rpc_event_id: string;
  source: EventSource;
  ingested_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface IngestCursorsTable {
  contract_id: string;
  last_ledger: number;
  updated_at: ColumnType<Date, string | Date | undefined, string | Date>;
}

export interface IngestGapsTable {
  /** bigserial: omitted on insert. */
  id: ColumnType<number, number | undefined, never>;
  contract_id: string;
  from_ledger: number;
  to_ledger: number;
  /** 'retention' today; kept free-text for future explicit reasons. */
  reason: string;
  detected_at: ColumnType<Date, string | Date | undefined, never>;
}

export interface Database {
  indexer_meta: IndexerMetaTable;
  raw_events: RawEventsTable;
  ingest_cursors: IngestCursorsTable;
  ingest_gaps: IngestGapsTable;
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
