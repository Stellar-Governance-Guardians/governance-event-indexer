import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { createSchema, createYoga } from 'graphql-yoga';
import { GraphQLError, GraphQLScalarType, Kind, type GraphQLSchema } from 'graphql';
import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { hasOpenGaps } from '../ingest/store.js';
import type { SorobanRpcClient } from '../rpc/client.js';

const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (value: unknown) => value,
  parseValue: (value: unknown) => value,
  parseLiteral: (node) => {
    if (node.kind === Kind.STRING || node.kind === Kind.BOOLEAN) return node.value;
    if (node.kind === Kind.INT || node.kind === Kind.FLOAT) return Number(node.value);
    if (node.kind === Kind.NULL) return null;
    throw new GraphQLError('JSON input must be a scalar value');
  },
});

export interface GraphqlContext {
  db: Kysely<Database>;
  rpc: SorobanRpcClient;
}

function failUnavailable(field: string): never {
  throw new GraphQLError(`${field} is unavailable: decoded governance tables are not populated yet`);
}

function parseCursor(after: string | null | undefined): number {
  if (after === null || after === undefined || after === '') return 0;
  const decoded = Buffer.from(after, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new GraphQLError('after is not a valid event cursor');
  return Number(decoded);
}

function cursorFor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function jsonTopics(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new GraphQLError('raw_events.topics is not a JSON array of strings');
  }
  return value;
}

export function buildGraphqlSchema(typeDefs: string): GraphQLSchema {
  return createSchema<GraphqlContext>({
    typeDefs,
    resolvers: {
      JSON: JSONScalar,
      Query: {
        events: async (
          _root: unknown,
          args: {
            contractId?: string | null;
            fromLedger?: number | null;
            toLedger?: number | null;
            first?: number | null;
            after?: string | null;
          },
          context: GraphqlContext,
        ) => {
          const first = args.first ?? 50;
          if (!Number.isSafeInteger(first) || first < 1 || first > 100) {
            throw new GraphQLError('first must be an integer between 1 and 100');
          }
          const offset = parseCursor(args.after);
          let query = context.db.selectFrom('raw_events').selectAll().orderBy('ledger').orderBy('tx_hash').orderBy('op_index').orderBy('event_index').limit(first + 1).offset(offset);
          if (args.contractId !== null && args.contractId !== undefined) query = query.where('contract_id', '=', args.contractId);
          if (args.fromLedger !== null && args.fromLedger !== undefined) query = query.where('ledger', '>=', args.fromLedger);
          if (args.toLedger !== null && args.toLedger !== undefined) query = query.where('ledger', '<=', args.toLedger);
          const rows = await query.execute();
          const hasNextPage = rows.length > first;
          const page = rows.slice(0, first);
          return {
            edges: page.map((row, index) => ({
              cursor: cursorFor(offset + index + 1),
              node: {
                governor: 'unverified',
                topics: jsonTopics(row.topics),
                ledger: row.ledger,
                txHash: row.tx_hash,
                contractId: row.contract_id,
                payload: { rawTopics: jsonTopics(row.topics), rawValue: row.value, source: row.source },
                decoding: 'UNVERIFIED',
              },
            })),
            pageInfo: {
              hasNextPage,
              endCursor: page.length === 0 ? null : cursorFor(offset + page.length),
            },
          };
        },
        proposal: () => failUnavailable('proposal'),
        executionImpact: () => failUnavailable('executionImpact'),
        delegateMetrics: () => failUnavailable('delegateMetrics'),
        indexerHealth: async (_root: unknown, _args: unknown, context: GraphqlContext) => {
          const health = await context.rpc.getHealth();
          const cursor = await context.db.selectFrom('ingest_cursors').select(({ fn }) => fn.max('last_ledger').as('cursor')).executeTakeFirst();
          const cursorLedger = cursor?.cursor === null || cursor?.cursor === undefined ? 0 : Number(cursor.cursor);
          const gap = await hasOpenGaps(context.db);
          return {
            cursorLedger,
            latestLedger: health.latestLedger,
            oldestLedger: health.oldestLedger,
            ledgerRetentionWindow: health.ledgerRetentionWindow,
            lagLedgers: Math.max(0, health.latestLedger - cursorLedger),
            healthy: health.status === 'healthy' && !gap,
          };
        },
      },
    },
  });
}

export function createGraphqlHttpServer(context: GraphqlContext, typeDefs: string): ReturnType<typeof createServer> {
  const yoga = createYoga<GraphqlContext>({
    schema: buildGraphqlSchema(typeDefs),
    graphqlEndpoint: '/graphql',
    maskedErrors: false,
    cors: false,
    healthCheckEndpoint: '/health',
  });
  return createServer(createServerAdapter(yoga).requestListener);
}

export function loadSchema(path = `${process.cwd()}/schema/governance-v1.graphql`): string {
  return readFileSync(path, 'utf8');
}
