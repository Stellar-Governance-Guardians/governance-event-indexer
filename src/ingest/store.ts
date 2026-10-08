/**
 * Ingestion persistence (I2): raw_events upserts, per-contract cursors, and
 * explicit gap rows — all transactional so a killed process either committed
 * a whole window (events + cursor) or nothing at all.
 */

import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, EventSource } from '../db/index.js';
import type { RawEventRow } from './normalize.js';

export type Db = Kysely<Database> | Transaction<Database>;

export const RAW_EVENT_KEY = [
  'ledger',
  'tx_hash',
  'op_index',
  'event_index',
] as const;

/**
 * Insert rows idempotently. ON CONFLICT DO NOTHING: raw rows are immutable,
 * so a re-run of the same window cannot change committed state (restart tests
 * assert byte-identical convergence) and `source` is never flipped by a
 * later write. Duplicates *within* the batch are folded first — Postgres
 * rejects a VALUES list that touches the same key twice in one INSERT.
 *
 * Returns the number of rows actually inserted.
 */
export async function insertRawEvents(db: Db, rows: readonly RawEventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const unique = new Map<string, RawEventRow>();
  for (const r of rows) {
    unique.set(`${r.ledger}|${r.tx_hash}|${r.op_index}|${r.event_index}`, r);
  }
  const result = await db
    .insertInto('raw_events')
    .values([...unique.values()].map((r) => ({ ...r, topics: JSON.stringify(r.topics) })))
    .onConflict((oc) => oc.columns([...RAW_EVENT_KEY]).doNothing())
    .executeTakeFirst();
  return Number(result?.numInsertedOrUpdatedRows ?? 0);
}

export async function getCursor(db: Db, contractId: string): Promise<number | undefined> {
  const row = await db
    .selectFrom('ingest_cursors')
    .select('last_ledger')
    .where('contract_id', '=', contractId)
    .executeTakeFirst();
  return row?.last_ledger;
}

/** Insert-or-move-forward the cursor. Never moves backward (stale writer safe). */
export async function advanceCursor(db: Db, contractId: string, lastLedger: number): Promise<void> {
  await sql`
    INSERT INTO ingest_cursors (contract_id, last_ledger)
    VALUES (${contractId}, ${lastLedger})
    ON CONFLICT (contract_id) DO UPDATE
      SET last_ledger = GREATEST(ingest_cursors.last_ledger, EXCLUDED.last_ledger),
          updated_at = now()
  `.execute(db);
}

export interface IngestGap {
  contractId: string;
  fromLedger: number;
  toLedger: number;
  reason: string;
}

/** Record a gap. Idempotent: re-detecting the same range keeps one row. */
export async function recordGap(db: Db, gap: IngestGap): Promise<boolean> {
  if (gap.fromLedger > gap.toLedger) {
    throw new Error(
      `gap from_ledger ${gap.fromLedger} > to_ledger ${gap.toLedger} (contract ${gap.contractId})`,
    );
  }
  const result = await db
    .insertInto('ingest_gaps')
    .values({
      contract_id: gap.contractId,
      from_ledger: gap.fromLedger,
      to_ledger: gap.toLedger,
      reason: gap.reason,
    })
    .onConflict((oc) => oc.columns(['contract_id', 'from_ledger', 'to_ledger']).doNothing())
    .executeTakeFirst();
  return Number(result?.numInsertedOrUpdatedRows ?? 0) > 0;
}

export async function listGaps(db: Db): Promise<
  { contract_id: string; from_ledger: number; to_ledger: number; reason: string }[]
> {
  return db
    .selectFrom('ingest_gaps')
    .select(['contract_id', 'from_ledger', 'to_ledger', 'reason'])
    .orderBy('contract_id')
    .orderBy('from_ledger')
    .execute();
}

export async function hasOpenGaps(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom('ingest_gaps')
    .select('contract_id')
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Commit one window atomically: raw rows + the cursor advance. A crash
 * between windows (or mid-transaction) leaves the cursor behind the events,
 * and the window is re-fetched idempotently on restart.
 */
export async function commitWindow(
  db: Db,
  args: { contractId: string; windowEnd: number; rows: readonly RawEventRow[] },
): Promise<number> {
  const inserted = await insertRawEvents(db, args.rows);
  await advanceCursor(db, args.contractId, args.windowEnd);
  return inserted;
}

export interface SourceCounts {
  live: number;
  fixtureReplay: number;
}

export async function countRawEventsBySource(db: Db): Promise<SourceCounts> {
  const rows = await db
    .selectFrom('raw_events')
    .select(['source', (eb) => eb.fn.countAll<number>().as('n')])
    .groupBy('source')
    .execute();
  const counts: SourceCounts = { live: 0, fixtureReplay: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    if (r.source === 'live') counts.live = n;
    else if (r.source === 'fixture-replay') counts.fixtureReplay = n;
  }
  return counts;
}

export type { EventSource };
