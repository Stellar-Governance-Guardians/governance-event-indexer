import { graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { withDatabase, type Database } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { buildGraphqlSchema, loadSchema } from '../../src/graphql/server.js';
import type { RawEventRow } from '../../src/ingest/normalize.js';
import { persistProposals } from '../../src/ingest/store.js';
import type { DecodedEventRecord } from '../../src/parser/wasm.js';
import { createHealthCache } from '../../src/rpc/health-cache.js';
import { withTempDatabase } from './helpers/db.js';

const schema = buildGraphqlSchema(loadSchema());
const GOVERNOR = 'CCKGJBCBBYNWCMSBPV67DFIG3OL72RLDKNGHWJQCR5NASAUHOQRNLEDX';
const TREASURY = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const TX = '34dd7cef8df6234f381563fff88b27a1163557f344f39832ff0e9901711215e3';

const RAW: RawEventRow = {
  ledger: 5_035_906,
  tx_hash: TX,
  op_index: 1,
  event_index: 0,
  contract_id: GOVERNOR,
  event_type: 'contract',
  ledger_closed_at: new Date('2026-10-05T12:25:17Z'),
  topics: ['AAAADwAAABBwcm9wb3NhbF9jcmVhdGVk'],
  value: 'AAAAEQ==',
  in_successful_contract_call: true,
  rpc_event_id: '0000000000000000000-0000000000',
  source: 'live',
};

function decoded(proposalId: number): DecodedEventRecord {
  return {
    parserVersion: '0.1.0-alpha.2',
    governor: 'script3',
    topics: ['proposal_created'],
    payload: {
      normalized: {
        proposal_id: proposalId,
        proposer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        title: 'Fund parser audit',
        description: 'Pay the auditor',
        action: {
          variant: 'calldata',
          contract_id: TREASURY,
          function: 'transfer',
          args: ['GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', TREASURY, '1000'],
          auths: [],
          amount_index: 2,
        },
        vote_start: 100,
        vote_end: 200,
      },
      rawTopics: RAW.topics,
      rawValue: RAW.value,
      source: 'live',
    },
    decoding: 'VERIFIED',
  };
}

function context(db: Kysely<Database>) {
  const rpc = {
    getHealth: async () => ({
      status: 'healthy',
      latestLedger: 6_000_000,
      oldestLedger: 5_900_000,
      ledgerRetentionWindow: 120_960,
    }),
    getEvents: async () => {
      throw new Error('resolvers must not call getEvents');
    },
  };
  return { db, rpc, health: createHealthCache(rpc, 0) };
}

async function withMigratedDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  return withTempDatabase((url) =>
    withDatabase(url, async (db) => {
      await runMigrations(db);
      return fn(db);
    }),
  );
}

const PROPOSAL = `query Proposal($id: String!, $governor: String!) {
  proposal(proposalId: $id, governorContract: $governor) {
    governor proposalId proposer decoding
    calls { contractId functionName arguments decoding risk { tier matchedRule verified } }
  }
}`;

describe('proposal projection + resolver', () => {
  it('serves a projected proposal with parser risk classifications', async () => {
    await withMigratedDb(async (db) => {
      const projected = await persistProposals(db, [{ raw: RAW, decoded: decoded(7) }]);
      expect(projected).toBe(1);

      const result = await graphql({
        schema,
        source: PROPOSAL,
        contextValue: context(db),
        variableValues: { id: '7', governor: GOVERNOR },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.proposal).toEqual({
        governor: 'script3',
        proposalId: '7',
        proposer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        decoding: 'VERIFIED',
        calls: [
          {
            contractId: TREASURY,
            functionName: 'transfer',
            arguments: [
              'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              TREASURY,
              '1000',
            ],
            decoding: 'UNVERIFIED',
            risk: { tier: 'LOW', matchedRule: 'no contextual rule fired', verified: false },
          },
        ],
      });
    });
  });

  it('is idempotent: re-projecting the same event updates rather than duplicates', async () => {
    await withMigratedDb(async (db) => {
      await persistProposals(db, [{ raw: RAW, decoded: decoded(7) }]);
      await persistProposals(db, [{ raw: RAW, decoded: decoded(7) }]);
      const rows = await db.selectFrom('proposals').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.proposal_id).toBe('7');
      expect(rows[0]?.created_ledger).toBe(5_035_906);
    });
  });

  it('returns null for a proposal the indexer has not projected (never synthesizes one)', async () => {
    await withMigratedDb(async (db) => {
      // Another contract's proposal 7 exists; the asked-for governor has none.
      await persistProposals(db, [{ raw: RAW, decoded: decoded(7) }]);
      const result = await graphql({
        schema,
        source: PROPOSAL,
        contextValue: context(db),
        variableValues: { id: '7', governor: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM' },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data?.proposal).toBeNull();
    });
  });

  it('rejects a stored call whose risk tier is not in the vendored SDL', async () => {
    await withMigratedDb(async (db) => {
      await persistProposals(db, [{ raw: RAW, decoded: decoded(8) }]);
      // Simulate a projection written by a newer parser with an unpublishable tier.
      await db
        .updateTable('proposals')
        .set({
          calls: JSON.stringify([
            {
              contract_id: TREASURY,
              function_name: 'transfer',
              arguments: [],
              decoding: 'verified',
              risk: { tier: 'catastrophic', matched_rule: 'x', verified: true },
            },
          ]),
        })
        .where('proposal_id', '=', '8')
        .execute();
      const result = await graphql({
        schema,
        source: PROPOSAL,
        contextValue: context(db),
        variableValues: { id: '8', governor: GOVERNOR },
      });
      expect(result.errors?.[0]?.message).toMatch(/unknown risk tier/);
    });
  });
});
