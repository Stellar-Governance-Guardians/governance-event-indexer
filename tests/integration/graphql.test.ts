import { graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { withDatabase, type Database } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { buildGraphqlSchema, loadSchema } from '../../src/graphql/server.js';
import { createHealthCache } from '../../src/rpc/health-cache.js';
import { withTempDatabase } from './helpers/db.js';
import type { Kysely } from 'kysely';

/**
 * Resolver tests against a real Postgres and the vendored SDL. No mocks: the
 * schema is built from schema/governance-v1.graphql and executed by graphql-js.
 */
const schema = buildGraphqlSchema(loadSchema());

const TX_A = 'a'.repeat(64);
const TX_B = 'b'.repeat(64);
const CONTRACT = 'CCKGJBCBBYNWCMSBPV67DFIG3OL72RLDKNGHWJQCR5NASAUHOQRNLEDX';

const HEALTH = {
  status: 'healthy',
  latestLedger: 5_000,
  oldestLedger: 4_000,
  ledgerRetentionWindow: 1_000,
};

function context(db: Kysely<Database>) {
  const rpc = {
    getHealth: async () => HEALTH,
    getEvents: async () => {
      throw new Error('resolvers must not call getEvents');
    },
  };
  return { db, rpc, health: createHealthCache(rpc, 0) };
}

async function seed(db: Kysely<Database>): Promise<void> {
  await runMigrations(db);
  await db
    .insertInto('raw_events')
    .values([
      row(100, TX_A, 0, 0, 'live'),
      row(100, TX_A, 0, 1, 'live'),
      row(101, TX_B, 2, 0, 'fixture-replay'),
    ])
    .execute();
  await db
    .insertInto('decoded_events')
    .values([
      {
        ledger: 100,
        tx_hash: TX_A,
        op_index: 0,
        event_index: 0,
        parser_version: '0.1.0-alpha.2',
        governor: 'script3-soroban-governor',
        topics: JSON.stringify(['vote_cast']),
        payload: JSON.stringify({ source: 'live', normalized: { proposal_id: 1 } }),
        decoding: 'VERIFIED',
      },
    ])
    .execute();
  await db
    .insertInto('ingest_cursors')
    .values({ contract_id: CONTRACT, last_ledger: 101 })
    .execute();
}

function row(
  ledger: number,
  txHash: string,
  opIndex: number,
  eventIndex: number,
  source: 'live' | 'fixture-replay',
) {
  return {
    ledger,
    tx_hash: txHash,
    op_index: opIndex,
    event_index: eventIndex,
    contract_id: CONTRACT,
    event_type: 'contract',
    ledger_closed_at: new Date('2026-10-05T12:25:17Z'),
    topics: JSON.stringify(['AAAADwAAAAl2b3RlX2Nhc3QAAAA=']),
    value: 'AAAAAwAAAAE=',
    in_successful_contract_call: true,
    rpc_event_id: `${ledger}-${eventIndex}`,
    source,
  };
}

const EVENTS = `query Events($first: Int, $after: String) {
  events(first: $first, after: $after) {
    edges { cursor node { governor ledger txHash decoding payload } }
    pageInfo { hasNextPage endCursor }
  }
}`;

describe('events resolver', () => {
  it('returns rows in keyset order and pages without repeating a key', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        const ctx = context(db);

        const first = await graphql({ schema, source: EVENTS, contextValue: ctx, variableValues: { first: 2 } });
        expect(first.errors).toBeUndefined();
        const page1 = first.data?.events as {
          edges: { cursor: string; node: { ledger: number; decoding: string } }[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
        expect(page1.edges.map((e) => e.node.ledger)).toEqual([100, 100]);
        expect(page1.pageInfo.hasNextPage).toBe(true);

        const second = await graphql({
          schema,
          source: EVENTS,
          contextValue: ctx,
          variableValues: { first: 2, after: page1.pageInfo.endCursor },
        });
        expect(second.errors).toBeUndefined();
        const page2 = second.data?.events as typeof page1;
        expect(page2.edges).toHaveLength(1);
        expect(page2.edges[0]?.node.ledger).toBe(101);
        expect(page2.pageInfo.hasNextPage).toBe(false);
        expect(page2.edges[0]?.cursor).not.toBe(page1.edges[1]?.cursor);
      });
    });
  });

  it('keeps an event without a decode record explicitly UNVERIFIED with its raw payload', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        const result = await graphql({
          schema,
          source: EVENTS,
          contextValue: context(db),
          variableValues: { first: 10 },
        });
        expect(result.errors).toBeUndefined();
        const edges = (result.data?.events as { edges: { node: Record<string, unknown> }[] }).edges;
        expect(edges[0]?.node.governor).toBe('script3-soroban-governor');
        expect(edges[0]?.node.decoding).toBe('VERIFIED');
        expect((edges[1]?.node.payload as { reason: string }).reason).toBe('decode record missing');
        expect(edges[1]?.node.decoding).toBe('UNVERIFIED');
      });
    });
  });

  it('rejects a page size outside 1..100 and a non-keyset cursor', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        const tooBig = await graphql({
          schema,
          source: EVENTS,
          contextValue: context(db),
          variableValues: { first: 101 },
        });
        expect(tooBig.errors?.[0]?.message).toMatch(/first must be an integer between 1 and 100/);

        const oldOffset = Buffer.from('1', 'utf8').toString('base64url');
        const badCursor = await graphql({
          schema,
          source: EVENTS,
          contextValue: context(db),
          variableValues: { first: 1, after: oldOffset },
        });
        expect(badCursor.errors?.[0]?.message).toMatch(/not a valid event cursor/);
      });
    });
  });
});

describe('not-yet-built resolvers', () => {
  it('fail loudly instead of returning fake or empty data', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        const ctx = context(db);
        for (const source of [
          'query { proposal(proposalId: "1", governorContract: "C") { governor } }',
          'query { delegateMetrics(delegate: "G") { votesCast } }',
          'query { executionImpact(proposalId: "1", governorContract: "C") { estimate } }',
        ]) {
          const result = await graphql({ schema, source, contextValue: ctx });
          // The SDL declares these fields nullable, so graphql-js nulls the
          // field rather than the whole data object. What matters is that the
          // resolver raises instead of fabricating an empty result.
          expect(result.errors?.[0]?.message).toMatch(
            /is unavailable: decoded governance tables are not populated yet/,
          );
          // Non-null SDL fields null the whole data object; nullable ones are
          // nulled individually. Either way no fabricated value may appear.
          const data = result.data ?? {};
          expect(Object.values(data).every((value) => value === null)).toBe(true);
        }
      });
    });
  });
});

describe('indexerHealth resolver', () => {
  it('reports the cursor, lag and gap state from the database and the cached RPC read', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        const result = await graphql({
          schema,
          source: 'query { indexerHealth { cursorLedger latestLedger oldestLedger ledgerRetentionWindow lagLedgers healthy } }',
          contextValue: context(db),
        });
        expect(result.errors).toBeUndefined();
        expect(result.data?.indexerHealth).toEqual({
          cursorLedger: 101,
          latestLedger: 5_000,
          oldestLedger: 4_000,
          ledgerRetentionWindow: 1_000,
          lagLedgers: 4_899,
          healthy: true,
        });
      });
    });
  });

  it('is unhealthy when an ingest gap is recorded', async () => {
    await withTempDatabase(async (url) => {
      await withDatabase(url, async (db) => {
        await seed(db);
        await db
          .insertInto('ingest_gaps')
          .values({ contract_id: CONTRACT, from_ledger: 1, to_ledger: 2, reason: 'retention' })
          .execute();
        const result = await graphql({
          schema,
          source: 'query { indexerHealth { healthy } }',
          contextValue: context(db),
        });
        expect(result.data?.indexerHealth).toEqual({ healthy: false });
      });
    });
  });
});

describe('vendored SDL contract', () => {
  it('serves every field the vendored governance-v1 SDL declares', () => {
    const typeMap = schema.getTypeMap();
    for (const name of ['Query', 'NormalizedEvent', 'EventConnection', 'EventEdge', 'PageInfo', 'IndexerHealth']) {
      const type = typeMap[name];
      expect(type, `${name} is in the served schema`).toBeDefined();
    }
    const query = schema.getQueryType();
    expect(Object.keys(query?.getFields() ?? {}).sort()).toEqual([
      'delegateMetrics',
      'events',
      'executionImpact',
      'indexerHealth',
      'proposal',
    ]);
  });
});
