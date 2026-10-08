import { sql, type Kysely } from 'kysely';
import type { Database } from '../index.js';

/**
 * 0002_ingest — raw ingestion tables (I2).
 *
 * - raw_events: raw RPC events, keyed (ledger, tx_hash, op_index, event_index)
 *   for idempotent, restart-safe writes. Rows are immutable: re-ingestion uses
 *   ON CONFLICT DO NOTHING so a killed run converges to byte-identical state.
 *   `source` distinguishes live ingestation from fixture replay and is never
 *   flipped by a later write (no silent mixing).
 * - ingest_cursors: one persisted cursor per registered contract.
 * - ingest_gaps: explicit ledger ranges we could NOT read (retention overrun).
 *   A gap row is a contract with /health — never a silent skip.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE raw_events (
      ledger                       bigint      NOT NULL,
      tx_hash                      text        NOT NULL,
      op_index                     integer     NOT NULL,
      event_index                  integer     NOT NULL,
      contract_id                  text        NOT NULL,
      event_type                   text        NOT NULL,
      ledger_closed_at             timestamptz,
      topics                       jsonb       NOT NULL,
      value                        text        NOT NULL,
      in_successful_contract_call  boolean     NOT NULL,
      rpc_event_id                 text        NOT NULL,
      source                       text        NOT NULL CHECK (source IN ('live', 'fixture-replay')),
      ingested_at                  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ledger, tx_hash, op_index, event_index)
    )
  `.execute(db);
  await sql`
    CREATE INDEX raw_events_contract_ledger_idx
      ON raw_events (contract_id, ledger)
  `.execute(db);
  await sql`
    CREATE INDEX raw_events_source_idx ON raw_events (source)
  `.execute(db);

  await sql`
    CREATE TABLE ingest_cursors (
      contract_id text        PRIMARY KEY,
      last_ledger bigint      NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE ingest_gaps (
      contract_id text        NOT NULL,
      from_ledger bigint      NOT NULL,
      to_ledger   bigint      NOT NULL,
      reason      text        NOT NULL,
      detected_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contract_id, from_ledger, to_ledger),
      CHECK (from_ledger <= to_ledger)
    )
  `.execute(db);
}
