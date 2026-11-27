import { sql, type Kysely } from 'kysely';
import type { Database } from '../index.js';

/**
 * 0004_proposals — proposal projection (I5).
 *
 * `decoded_events` is the durable decode record; this table is the queryable
 * projection the `proposal` GraphQL field reads. Each row is derived from one
 * VERIFIED `proposal_created` event and keeps the projected `DecodedCall` list
 * exactly as the pinned parser produced it (risk tier + matched rule included).
 *
 * Keyed by (contract_id, proposal_id): the same numeric id can exist on two
 * governors, so the contract id is part of the identity, not decoration.
 * `decoding` is explicit — a projection that could not produce calls is stored
 * as UNVERIFIED with an empty call list rather than being dropped or faked.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE proposals (
      contract_id     text        NOT NULL,
      governor        text        NOT NULL,
      proposal_id     text        NOT NULL,
      created_ledger  bigint      NOT NULL,
      created_tx_hash text        NOT NULL,
      proposer        text,
      title           text,
      calls           jsonb       NOT NULL,
      decoding        text        NOT NULL CHECK (decoding IN ('VERIFIED', 'UNVERIFIED')),
      parser_version  text        NOT NULL,
      projected_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (contract_id, proposal_id)
    )
  `.execute(db);
  await sql`
    CREATE INDEX proposals_created_idx ON proposals (contract_id, created_ledger)
  `.execute(db);
}
