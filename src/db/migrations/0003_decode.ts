import { sql, type Kysely } from 'kysely';
import type { Database } from '../index.js';

/**
 * 0003_decode — durable parser output (I3).
 *
 * Raw RPC events remain immutable and are the source of truth. This table is
 * a replayable projection keyed to the raw event identity, with the exact
 * parser pin and an explicit VERIFIED/UNVERIFIED status for auditability.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE decoded_events (
      ledger         bigint NOT NULL,
      tx_hash        text NOT NULL,
      op_index       integer NOT NULL,
      event_index    integer NOT NULL,
      parser_version text NOT NULL,
      governor       text NOT NULL,
      topics         jsonb NOT NULL,
      payload        jsonb NOT NULL,
      decoding       text NOT NULL CHECK (decoding IN ('VERIFIED', 'UNVERIFIED')),
      decoded_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ledger, tx_hash, op_index, event_index),
      FOREIGN KEY (ledger, tx_hash, op_index, event_index)
        REFERENCES raw_events (ledger, tx_hash, op_index, event_index)
        ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE INDEX decoded_events_governor_idx ON decoded_events (governor)
  `.execute(db);
  await sql`
    CREATE INDEX decoded_events_status_idx ON decoded_events (decoding)
  `.execute(db);
}
