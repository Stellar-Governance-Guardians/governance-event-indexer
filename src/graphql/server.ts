import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServerAdapter } from '@whatwg-node/server';
import { createSchema, createYoga } from 'graphql-yoga';
import { GraphQLError, GraphQLScalarType, Kind, type GraphQLSchema } from 'graphql';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import { hasOpenGaps } from '../ingest/store.js';
import type { HealthResult, SorobanRpcClient } from '../rpc/client.js';

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

/** Short-lived cache around the RPC health call. See `createHealthCache`. */
export interface HealthSource {
  get(): Promise<HealthResult>;
}

export interface GraphqlContext {
  db: Kysely<Database>;
  rpc: SorobanRpcClient;
  /** Cached health reads; `/graphql` and `/health` must not hit the RPC per request. */
  health: HealthSource;
}

function failUnavailable(field: string): never {
  throw new GraphQLError(`${field} is unavailable: decoded governance tables are not populated yet`);
}

/** The stable key a keyset cursor is built from. Ordering matches the index. */
export interface EventCursor {
  ledger: number;
  txHash: string;
  opIndex: number;
  eventIndex: number;
}

/**
 * Keyset cursors, not LIMIT/OFFSET: concurrent ingestion inserts rows *behind*
 * the reader, and an offset would then repeat or skip rows. The cursor encodes
 * the last returned key exactly, so a page is always "strictly after this key".
 */
export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.ledger, cursor.txHash, cursor.opIndex, cursor.eventIndex]),
    'utf8',
  ).toString('base64url');
}

export function parseCursor(after: string | null | undefined): EventCursor | undefined {
  if (after === null || after === undefined || after === '') return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
  } catch {
    throw new GraphQLError('after is not a valid event cursor');
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 4 ||
    typeof decoded[0] !== 'number' ||
    !Number.isSafeInteger(decoded[0]) ||
    decoded[0] < 0 ||
    typeof decoded[1] !== 'string' ||
    decoded[1] === '' ||
    typeof decoded[2] !== 'number' ||
    !Number.isSafeInteger(decoded[2]) ||
    decoded[2] < 0 ||
    typeof decoded[3] !== 'number' ||
    !Number.isSafeInteger(decoded[3]) ||
    decoded[3] < 0
  ) {
    throw new GraphQLError('after is not a valid event cursor');
  }
  return { ledger: decoded[0], txHash: decoded[1], opIndex: decoded[2], eventIndex: decoded[3] };
}

function jsonTopics(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new GraphQLError('raw_events.topics is not a JSON array of strings');
  }
  return value;
}

function missingDecodedEvent(row: {
  contract_id: string;
  ledger: number;
  tx_hash: string;
  topics: unknown;
  value: string;
  source: string;
}) {
  const topics = jsonTopics(row.topics);
  return {
    governor: 'unverified', topics, ledger: row.ledger, txHash: row.tx_hash,
    contractId: row.contract_id,
    payload: { rawTopics: topics, rawValue: row.value, source: row.source, reason: 'decode record missing' },
    decoding: 'UNVERIFIED' as const,
  };
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
          const after = parseCursor(args.after);
          let query = context.db.selectFrom('raw_events').leftJoin('decoded_events', (join) => join
            .onRef('decoded_events.ledger', '=', 'raw_events.ledger')
            .onRef('decoded_events.tx_hash', '=', 'raw_events.tx_hash')
            .onRef('decoded_events.op_index', '=', 'raw_events.op_index')
            .onRef('decoded_events.event_index', '=', 'raw_events.event_index'))
            .selectAll('raw_events').select([
              'decoded_events.governor as decoded_governor', 'decoded_events.topics as decoded_topics',
              'decoded_events.payload as decoded_payload', 'decoded_events.decoding',
            ])
            .orderBy('raw_events.ledger')
            .orderBy('raw_events.tx_hash')
            .orderBy('raw_events.op_index')
            .orderBy('raw_events.event_index')
            .limit(first + 1);
          if (after !== undefined) {
            // Row-value comparison over the full primary key; the index is
            // built on exactly this tuple order.
            query = query.where(sql<boolean>`(raw_events.ledger, raw_events.tx_hash, raw_events.op_index, raw_events.event_index)
              > (${after.ledger}, ${after.txHash}, ${after.opIndex}, ${after.eventIndex})`);
          }
          if (args.contractId !== null && args.contractId !== undefined) query = query.where('raw_events.contract_id', '=', args.contractId);
          if (args.fromLedger !== null && args.fromLedger !== undefined) query = query.where('raw_events.ledger', '>=', args.fromLedger);
          if (args.toLedger !== null && args.toLedger !== undefined) query = query.where('raw_events.ledger', '<=', args.toLedger);
          const rows = await query.execute();
          const hasNextPage = rows.length > first;
          const page = rows.slice(0, first);
          return {
            edges: page.map((row) => ({
              cursor: encodeCursor({
                ledger: row.ledger,
                txHash: row.tx_hash,
                opIndex: row.op_index,
                eventIndex: row.event_index,
              }),
              node: row.decoded_governor === null || row.decoded_governor === undefined
                ? missingDecodedEvent(row)
                : { governor: row.decoded_governor, topics: jsonTopics(row.decoded_topics), ledger: row.ledger,
                    txHash: row.tx_hash, contractId: row.contract_id, payload: row.decoded_payload,
                    decoding: row.decoding },
            })),
            pageInfo: {
              hasNextPage,
              endCursor: page.length === 0
                ? null
                : encodeCursor({
                    ledger: page[page.length - 1]!.ledger,
                    txHash: page[page.length - 1]!.tx_hash,
                    opIndex: page[page.length - 1]!.op_index,
                    eventIndex: page[page.length - 1]!.event_index,
                  }),
            },
          };
        },
        proposal: () => failUnavailable('proposal'),
        executionImpact: () => failUnavailable('executionImpact'),
        delegateMetrics: () => failUnavailable('delegateMetrics'),
        indexerHealth: async (_root: unknown, _args: unknown, context: GraphqlContext) => {
          const health = await context.health.get();
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
    // Deliberate: unexpected failures are masked with a stable code, while
    // every intentional failure below is a GraphQLError and passes through
    // unmasked (see docs/deploy.md, "Error responses").
    maskedErrors: {
      // Yoga wraps a resolver failure in a located GraphQLError, so the
      // client-safe error is the one the resolver actually threw. Testing
      // only the outer object masked every intentional failure in practice.
      maskError: (error: unknown, message: string) => {
        const candidate =
          error instanceof Error && 'originalError' in error
            ? (error as { originalError?: unknown }).originalError ?? error
            : error;
        if (candidate instanceof GraphQLError) return candidate;
        return new GraphQLError(message, {
          extensions: { code: 'INTERNAL_SERVER_ERROR', unexpected: true },
          originalError: candidate instanceof Error ? candidate : undefined,
        });
      },
    },
    cors: false,
    healthCheckEndpoint: '/health',
  });
  return createServer(createServerAdapter(yoga).requestListener);
}

export function loadSchema(path = `${process.cwd()}/schema/governance-v1.graphql`): string {
  return readFileSync(path, 'utf8');
}
