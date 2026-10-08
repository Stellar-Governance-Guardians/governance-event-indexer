import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/index.js';
import { withDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { toRawEventRow } from '../../src/ingest/normalize.js';
import { ingestCatchUp, type IngestOptions } from '../../src/ingest/run.js';
import {
  advanceCursor,
  countRawEventsBySource,
  getCursor,
  hasOpenGaps,
  insertRawEvents,
  listGaps,
} from '../../src/ingest/store.js';
import { loadRegistry } from '../../src/registry/index.js';
import type {
  GetEventsParams,
  GetEventsResult,
  HealthResult,
  RpcEvent,
  SorobanRpcClient,
} from '../../src/rpc/client.js';
import { replayFixtureDir, replayFixtureFile, ReplayError } from '../../src/replay/run.js';
import { withTempDatabase } from './helpers/db.js';

const REGISTRY = loadRegistry({ root: process.cwd() });
const FIXTURE_GOV_ENTRY = REGISTRY.entries.find((e) => e.name === 'fixtureGovernor');
if (FIXTURE_GOV_ENTRY === undefined) {
  throw new Error('fixtureGovernor missing from the pinned registry — check deployments.json');
}
const FIXTURE_GOV = FIXTURE_GOV_ENTRY.contractId;

function mkEvent(ledger: number, n: number, contractId: string): RpcEvent {
  return {
    type: 'contract',
    ledger,
    ledgerClosedAt: new Date(1_700_000_000_000 + ledger * 1000).toISOString(),
    contractId,
    id: `${String(ledger).padStart(19, '0')}-${String(n).padStart(10, '0')}`,
    operationIndex: n % 3,
    transactionIndex: 0,
    txHash: n.toString(16).padStart(64, '0'),
    inSuccessfulContractCall: true,
    topic: ['AAAADwAAAAl2b3RlX2Nhc3QAAAA='],
    value: 'AAAAAg==',
  };
}

interface StubOptions {
  events: RpcEvent[];
  latestLedger: number;
  oldestLedger: number;
}

function stubRpc(opts: StubOptions): { client: SorobanRpcClient; rangedCalls: GetEventsParams[] } {
  const rangedCalls: GetEventsParams[] = [];
  const health: HealthResult = {
    status: 'healthy',
    latestLedger: opts.latestLedger,
    oldestLedger: opts.oldestLedger,
    ledgerRetentionWindow: 120960,
  };
  const client: SorobanRpcClient = {
    async getHealth() {
      return health;
    },
    async getEvents(params: GetEventsParams): Promise<GetEventsResult> {
      if (params.pagingToken === undefined) rangedCalls.push(params);
      const list = opts.events
        .filter((e) => e.contractId === params.contractIds[0])
        .sort((a, b) => a.ledger - b.ledger || a.id.localeCompare(b.id));
      let idx: number;
      let ranged = true;
      if (params.pagingToken !== undefined) {
        idx = Number(params.pagingToken);
        ranged = false;
      } else {
        idx = list.findIndex((e) => e.ledger >= params.startLedger);
        if (idx < 0) idx = list.length;
      }
      const limit = params.limit ?? 500;
      const events: RpcEvent[] = [];
      while (
        idx < list.length &&
        events.length < limit &&
        (ranged ? list[idx]!.ledger <= params.endLedger : true)
      ) {
        events.push(list[idx]!);
        idx += 1;
      }
      const cursor = idx < list.length ? String(idx) : undefined;
      return {
        events,
        cursor,
        latestLedger: opts.latestLedger,
        oldestLedger: opts.oldestLedger,
        latestLedgerCloseTime: '1791200807',
        oldestLedgerCloseTime: '1790596012',
      };
    },
  };
  return { client, rangedCalls };
}

async function withMigratedDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  return withTempDatabase((url) =>
    withDatabase(url, async (db) => {
      await runMigrations(db);
      return fn(db);
    }),
  );
}

async function snapshot(db: Kysely<Database>): Promise<{
  rows: Record<string, unknown>[];
  cursors: { contract_id: string; last_ledger: number }[];
}> {
  const rows = await db
    .selectFrom('raw_events')
    .selectAll()
    .orderBy('ledger')
    .orderBy('tx_hash')
    .orderBy('op_index')
    .orderBy('event_index')
    .execute();
  const cursors = await db
    .selectFrom('ingest_cursors')
    .select(['contract_id', 'last_ledger'])
    .orderBy('contract_id')
    .execute();
  // `ingested_at` is wall-clock bookkeeping (when THIS process wrote the row),
  // not event content — convergence is asserted on everything else.
  const content = rows.map(({ ingested_at: _ignored, ...rest }) => rest as Record<string, unknown>);
  return { rows: content, cursors };
}

describe('ingestCatchUp', () => {
  const events = [
    mkEvent(1000, 1, FIXTURE_GOV),
    mkEvent(1400, 2, FIXTURE_GOV),
    mkEvent(1999, 3, FIXTURE_GOV),
    mkEvent(2000, 4, FIXTURE_GOV),
    mkEvent(2500, 5, FIXTURE_GOV),
  ];
  const opts: IngestOptions = { windowLedgers: 1000 };

  it('pages in <=1000-ledger windows, stores events, lands the cursor at latest', async () => {
    await withMigratedDb(async (db) => {
      const { client, rangedCalls } = stubRpc({
        events,
        latestLedger: 2500,
        oldestLedger: 1000,
      });
      const report = await ingestCatchUp(db, client, REGISTRY, opts);

      // every ranged window respects the 1000-ledger cap
      expect(rangedCalls.length).toBeGreaterThan(0);
      for (const call of rangedCalls) {
        expect(call.endLedger - call.startLedger + 1).toBeLessThanOrEqual(1000);
      }

      const govReport = report.contracts.find((c) => c.contractId === FIXTURE_GOV);
      expect(govReport?.events).toBe(5);
      expect(govReport?.cursorAfter).toBe(2500);
      expect(govReport?.initializedCursorFrom).toBe(999); // oldest-1, nothing promised before
      expect(govReport?.gap).toBeUndefined();

      const rows = await db.selectFrom('raw_events').selectAll().execute();
      // only the registered governor's events are stored, even though the
      // registry lists 8+ contracts (others had no events)
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.contract_id === FIXTURE_GOV)).toBe(true);
      expect(await getCursor(db, FIXTURE_GOV)).toBe(2500);
      expect(await hasOpenGaps(db)).toBe(false);
    });
  });

  it('is idempotent: a full re-run converges to byte-identical state', async () => {
    await withMigratedDb(async (db) => {
      const first = stubRpc({ events, latestLedger: 2500, oldestLedger: 1000 });
      await ingestCatchUp(db, first.client, REGISTRY, opts);
      const before = await snapshot(db);

      // rewind the cursor — as a re-ingest would after a restore — and redo
      await db.deleteFrom('ingest_cursors').execute();
      const second = stubRpc({ events, latestLedger: 2500, oldestLedger: 1000 });
      const report = await ingestCatchUp(db, second.client, REGISTRY, opts);
      const after = await snapshot(db);

      expect(after.rows).toEqual(before.rows);
      expect(after.cursors).toEqual(before.cursors);
      const gov = report.contracts.find((c) => c.contractId === FIXTURE_GOV);
      expect(gov?.inserted).toBe(0); // everything already present: no double writes
    });
  });

  it('is restart-safe: events committed without a cursor advance converge identically', async () => {
    // Run A: simulate a kill after window-1 events hit the table but before
    // the cursor transaction committed (the crash artifact our atomic commit
    // prevents in production, exercised anyway to prove convergence).
    const stateA = await withMigratedDb(async (db) => {
      await insertRawEvents(
        db,
        events.filter((e) => e.ledger <= 1999).map((e) => toRawEventRow(e, 'live')),
      );
      expect(await getCursor(db, FIXTURE_GOV)).toBeUndefined(); // cursor never advanced
      const { client } = stubRpc({ events, latestLedger: 2500, oldestLedger: 1000 });
      await ingestCatchUp(db, client, REGISTRY, opts);
      return snapshot(db);
    });

    // Run B: clean uninterrupted ingest.
    const stateB = await withMigratedDb(async (db) => {
      const { client } = stubRpc({ events, latestLedger: 2500, oldestLedger: 1000 });
      await ingestCatchUp(db, client, REGISTRY, opts);
      return snapshot(db);
    });

    expect(stateA.rows).toEqual(stateB.rows);
    expect(stateA.cursors).toEqual(stateB.cursors);
    expect(stateA.rows).toHaveLength(5);
  });

  it('records an explicit retention gap and advances (never skips silently)', async () => {
    await withMigratedDb(async (db) => {
      // cursor far behind the RPC's retention window
      await advanceCursor(db, FIXTURE_GOV, 500);
      const { client } = stubRpc({ events, latestLedger: 1200, oldestLedger: 1000 });
      const report = await ingestCatchUp(db, client, REGISTRY, opts);

      const gaps = await listGaps(db);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({
        contract_id: FIXTURE_GOV,
        from_ledger: 501,
        to_ledger: 999,
        reason: 'retention',
      });
      expect(await hasOpenGaps(db)).toBe(true);

      const gov = report.contracts.find((c) => c.contractId === FIXTURE_GOV);
      expect(gov?.gap).toEqual({ fromLedger: 501, toLedger: 999, reason: 'retention' });
      expect(gov?.cursorAfter).toBe(1200);

      // second run: no duplicate gap rows, condition is gone
      const { client: again } = stubRpc({ events, latestLedger: 1200, oldestLedger: 1000 });
      const report2 = await ingestCatchUp(db, again, REGISTRY, opts);
      expect(await listGaps(db)).toHaveLength(1);
      expect(report2.contracts.find((c) => c.contractId === FIXTURE_GOV)?.gap).toBeUndefined();
      // gap detection only fires for the governor that was behind
      expect(report2.contracts.filter((c) => c.gap !== undefined)).toHaveLength(0);
    });
  });

  it('rejects a window size the public RPC cannot serve', async () => {
    await withMigratedDb(async (db) => {
      const { client } = stubRpc({ events, latestLedger: 1, oldestLedger: 1 });
      await expect(
        ingestCatchUp(db, client, REGISTRY, { windowLedgers: 5000 }),
      ).rejects.toThrow(/\[1, 1000\]/);
    });
  });
});

describe('fixture replay', () => {
  it('replays the pinned raw capture through the same path, tagged source=fixture-replay', async () => {
    await withMigratedDb(async (db) => {
      const outcomes = await replayFixtureDir(
        db,
        'tests/fixtures/replay',
        REGISTRY,
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ events: 2, inserted: 2, skippedUnregistered: [] });

      const rows = await db
        .selectFrom('raw_events')
        .selectAll()
        .orderBy('ledger')
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.source === 'fixture-replay')).toBe(true);
      expect(rows[0]!.ledger).toBe(5035906);
      expect(rows[1]!.ledger).toBe(5035908);
      // real capture keys: tx hashes from the parser repo's fixture
      expect(rows[0]!.tx_hash).toBe(
        '34dd7cef8df6234f381563fff88b27a1163557f344f39832ff0e9901711215e3',
      );

      // replay never touches live cursors
      expect(await getCursor(db, FIXTURE_GOV)).toBeUndefined();
      const counts = await countRawEventsBySource(db);
      expect(counts).toEqual({ live: 0, fixtureReplay: 2 });

      // idempotent: replaying again inserts nothing and keeps the source tag
      const again = await replayFixtureFile(
        db,
        'tests/fixtures/replay/phase1-fixture-events.json',
        REGISTRY,
      );
      expect(again.inserted).toBe(0);
      expect(await countRawEventsBySource(db)).toEqual({ live: 0, fixtureReplay: 2 });
    });
  });

  it('keeps live and replay rows distinguishable in one table (never mixed)', async () => {
    await withMigratedDb(async (db) => {
      await replayFixtureDir(db, 'tests/fixtures/replay', REGISTRY);
      // a live row for the SAME contract, different event
      await insertRawEvents(db, [toRawEventRow(mkEvent(5035910, 9, FIXTURE_GOV), 'live')]);

      const counts = await countRawEventsBySource(db);
      expect(counts).toEqual({ live: 1, fixtureReplay: 2 });

      const liveOnly = await db
        .selectFrom('raw_events')
        .selectAll()
        .where('source', '=', 'live')
        .execute();
      expect(liveOnly).toHaveLength(1);
      expect(liveOnly[0]!.ledger).toBe(5035910);

      // a conflicting rewrite cannot flip an existing row's source
      const conflict = await insertRawEvents(db, [
        toRawEventRow(mkEvent(5035910, 9, FIXTURE_GOV), 'fixture-replay'),
      ]);
      expect(conflict).toBe(0);
      const still = await db
        .selectFrom('raw_events')
        .select('source')
        .where('ledger', '=', 5035910)
        .executeTakeFirstOrThrow();
      expect(still.source).toBe('live');
    });
  });

  it('fails loud on fixtures for unregistered contracts unless explicitly allowed', async () => {
    await withMigratedDb(async (db) => {
      const dir = join(tmpdir(), `replay-test-${process.pid}`);
      // Well-formed strkey that is NOT in the pinned registry.
      const foreign = `C${'A'.repeat(55)}`;
      const body = {
        jsonrpc: '2.0',
        id: 2,
        result: {
          events: [{ ...mkEvent(10, 1, foreign) }],
          cursor: 'x',
          latestLedger: 11,
          oldestLedger: 1,
          latestLedgerCloseTime: '1791200807',
          oldestLedgerCloseTime: '1790596012',
        },
      };
      const { mkdirSync } = await import('node:fs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'foreign.json');
      writeFileSync(file, JSON.stringify(body));

      await expect(replayFixtureFile(db, file, REGISTRY)).rejects.toThrow(ReplayError);
      await expect(replayFixtureFile(db, file, REGISTRY)).rejects.toThrow(
        /unregistered contract/,
      );

      const ok = await replayFixtureFile(db, file, REGISTRY, { allowUnregistered: true });
      expect(ok).toMatchObject({ events: 1, inserted: 0, skippedUnregistered: [foreign] });
      expect(await countRawEventsBySource(db)).toEqual({ live: 0, fixtureReplay: 0 });
    });
  });
});
