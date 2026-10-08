/**
 * Ingestion orchestrator (I2).
 *
 * Live path — no fixture references anywhere in this file (charter rule 1).
 *
 * Per registered contract:
 *  1. cursor = persisted last_ledger, or (on first sight) the start of the
 *     RPC's retention window minus one — nothing is promised before it;
 *  2. if the cursor is older than the RPC's oldest ledger, the unreadable
 *     range is written to ingest_gaps (reason 'retention') and the cursor is
 *     advanced past it IN THE SAME TRANSACTION — a gap is loud, never silent,
 *     and /health will fail while one exists;
 *  3. windows of <= 1000 ledgers (public RPC times out on wider ranges) are
 *     fetched with paging, normalized, and committed atomically with the
 *     cursor advance — a killed process re-fetches and converges.
 */

import { MAX_WINDOW_LEDGERS } from '../config.js';
import type { Database } from '../db/index.js';
import type { Kysely } from 'kysely';
import type { GovernorRegistry } from '../registry/index.js';
import type { HealthResult, RpcEvent, SorobanRpcClient } from '../rpc/client.js';
import { toRawEventRow } from './normalize.js';
import { advanceCursor, commitWindow, getCursor, recordGap } from './store.js';

/** Events per getEvents page. 500 stays under the RPC's response cap. */
export const PAGE_LIMIT = 500;
/** Fail-loud guard against a paging loop that never terminates. */
export const MAX_PAGES_PER_WINDOW = 10_000;

export interface IngestOptions {
  /** Window size in ledgers; validated against MAX_WINDOW_LEDGERS. */
  windowLedgers: number;
  /** Stop after one window per contract (cron-style pass). */
  once?: boolean;
}

export interface IngestContractReport {
  contractId: string;
  /** Set when the cursor was created in this run. */
  initializedCursorFrom: number | undefined;
  /** Set when a retention gap was recorded in this run. */
  gap: { fromLedger: number; toLedger: number; reason: string } | undefined;
  windows: number;
  pages: number;
  events: number;
  inserted: number;
  cursorAfter: number;
}

export interface IngestReport {
  health: HealthResult;
  windowLedgers: number;
  contracts: IngestContractReport[];
}

export function validateWindowLedgers(windowLedgers: number): number {
  if (!Number.isInteger(windowLedgers) || windowLedgers < 1 || windowLedgers > MAX_WINDOW_LEDGERS) {
    throw new Error(
      `windowLedgers must be an integer in [1, ${MAX_WINDOW_LEDGERS}] (got ${windowLedgers}); ` +
        'the public RPC times out on wider ranges',
    );
  }
  return windowLedgers;
}

export interface WindowFetch {
  contractId: string;
  fromLedger: number;
  toLedger: number;
  limit?: number;
}

/**
 * Fetch every event for one contract in [from, to], following paging tokens.
 * Events beyond `toLedger` (possible once paging drops the range bound) are
 * dropped — the next window re-fetches them idempotently.
 */
export async function fetchWindowEvents(
  rpc: SorobanRpcClient,
  args: WindowFetch,
): Promise<{ events: RpcEvent[]; pages: number }> {
  const limit = args.limit ?? PAGE_LIMIT;
  const events: RpcEvent[] = [];
  let pagingToken: string | undefined;
  let pages = 0;

  for (;;) {
    const res = await rpc.getEvents({
      contractIds: [args.contractId],
      startLedger: args.fromLedger,
      endLedger: args.toLedger,
      ...(pagingToken !== undefined ? { pagingToken } : {}),
      limit,
    });
    pages += 1;
    if (pages > MAX_PAGES_PER_WINDOW) {
      throw new Error(
        `window ${args.contractId} [${args.fromLedger}, ${args.toLedger}] exceeded ${MAX_PAGES_PER_WINDOW} pages — paging is not terminating`,
      );
    }

    let sawBeyondWindow = false;
    for (const e of res.events) {
      if (e.ledger > args.toLedger) {
        sawBeyondWindow = true;
        continue;
      }
      if (e.ledger >= args.fromLedger && e.contractId === args.contractId) {
        events.push(e);
      }
    }

    if (sawBeyondWindow || res.events.length === 0 || res.events.length < limit) break;
    if (res.cursor === undefined) {
      throw new Error(
        `window ${args.contractId} [${args.fromLedger}, ${args.toLedger}]: full page returned but no paging cursor`,
      );
    }
    pagingToken = res.cursor;
  }

  return { events, pages };
}

async function ingestContract(
  db: Kysely<Database>,
  rpc: SorobanRpcClient,
  health: HealthResult,
  contractId: string,
  opts: IngestOptions,
): Promise<IngestContractReport> {
  const report: IngestContractReport = {
    contractId,
    initializedCursorFrom: undefined,
    gap: undefined,
    windows: 0,
    pages: 0,
    events: 0,
    inserted: 0,
    cursorAfter: 0,
  };

  let cursor = await getCursor(db, contractId);
  if (cursor === undefined) {
    cursor = Math.max(0, health.oldestLedger - 1);
    await advanceCursor(db, contractId, cursor);
    report.initializedCursorFrom = cursor;
  }

  if (cursor + 1 < health.oldestLedger) {
    const gap = {
      fromLedger: cursor + 1,
      toLedger: health.oldestLedger - 1,
      reason: 'retention',
    };
    await db.transaction().execute(async (trx) => {
      await recordGap(trx, {
        contractId,
        fromLedger: gap.fromLedger,
        toLedger: gap.toLedger,
        reason: gap.reason,
      });
      // GREATEST-semantics: idempotent whether or not the row was new.
      await advanceCursor(trx, contractId, gap.toLedger);
    });
    report.gap = gap;
    cursor = gap.toLedger;
  }

  while (cursor < health.latestLedger) {
    if (opts.once === true && report.windows >= 1) break;

    const from = cursor + 1;
    const to = Math.min(cursor + opts.windowLedgers, health.latestLedger);
    if (to <= cursor) {
      // Defensive: window must always make progress (windowLedgers >= 1).
      throw new Error(
        `window made no progress for ${contractId}: cursor ${cursor}, window [${from}, ${to}]`,
      );
    }

    const { events, pages } = await fetchWindowEvents(rpc, {
      contractId,
      fromLedger: from,
      toLedger: to,
    });
    const rows = events.map((e) => toRawEventRow(e, 'live'));
    const inserted = await commitWindow(db, { contractId, windowEnd: to, rows });

    report.windows += 1;
    report.pages += pages;
    report.events += rows.length;
    report.inserted += inserted;
    cursor = to;
  }

  report.cursorAfter = cursor;
  return report;
}

/**
 * One ingestion pass over every registered contract. Returns a report that is
 * safe to print (no secrets) and is the machine-readable evidence of what was
 * read, what was gap-recorded, and where each cursor now points.
 */
export async function ingestCatchUp(
  db: Kysely<Database>,
  rpc: SorobanRpcClient,
  registry: GovernorRegistry,
  opts: IngestOptions,
): Promise<IngestReport> {
  validateWindowLedgers(opts.windowLedgers);
  const health = await rpc.getHealth();
  if (health.oldestLedger > health.latestLedger) {
    throw new Error(
      `getHealth is inconsistent: oldestLedger ${health.oldestLedger} > latestLedger ${health.latestLedger}`,
    );
  }

  const contracts: IngestContractReport[] = [];
  for (const entry of registry.entries) {
    contracts.push(await ingestContract(db, rpc, health, entry.contractId, opts));
  }
  return { health, windowLedgers: opts.windowLedgers, contracts };
}
