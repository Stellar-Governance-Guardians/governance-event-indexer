import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGraphqlHttpServer,
  loadSchema,
  type GraphqlContext,
} from '../../src/graphql/server.js';

/**
 * The docs promise two different error behaviours, and they must not be
 * conflated:
 *
 *   - an intentional `GraphQLError` reaches the client verbatim (a precise
 *     "unavailable" reason, a bad cursor, a bad page size);
 *   - an unexpected driver/runtime failure is masked, carries
 *     `extensions.unexpected`, and never leaks internal text.
 *
 * This test uses the real SDL and the real Yoga server; only the database is a
 * stub, because the point is the error boundary, not Postgres.
 */

const HEALTH = {
  latestLedger: 5_083_120,
  oldestLedger: 4_960_000,
  ledgerRetentionWindow: 120_960,
  status: 'healthy' as const,
};

function throwingDb(): GraphqlContext['db'] {
  return {
    selectFrom: () => {
      throw new Error('connection terminated unexpectedly');
    },
  } as unknown as GraphqlContext['db'];
}

function context(db: GraphqlContext['db']): GraphqlContext {
  return {
    db,
    rpc: {} as GraphqlContext['rpc'],
    health: { get: async () => HEALTH },
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];

async function start(db: GraphqlContext['db']): Promise<string> {
  const server = createGraphqlHttpServer(context(db), loadSchema('schema/governance-v1.graphql'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/graphql`;
}

async function post(url: string, query: string): Promise<{
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await response.json()) as {
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('graphql error boundary', () => {
  it('masks an unexpected resolver failure and keeps the internal text out', async () => {
    const url = await start(throwingDb());
    const body = await post(
      url,
      `query { indexerHealth { cursorLedger latestLedger oldestLedger ledgerRetentionWindow lagLedgers healthy } }`,
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('connection terminated');
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.['unexpected']).toBe(true);
    expect(body.errors?.[0]?.extensions?.['code']).toBe('INTERNAL_SERVER_ERROR');
  });

  it('passes an intentional GraphQLError through unmasked', async () => {
    // `first: 0` is rejected before any query runs, so this exercises the
    // intentional path without a database.
    const url = await start(throwingDb());
    const body = await post(url, `query { events(first: 0) { pageInfo { hasNextPage } } }`);
    expect(body.errors?.[0]?.message).toMatch(/first must be an integer between 1 and 100/);
    expect(body.errors?.[0]?.extensions?.['unexpected']).toBeUndefined();
  });
});
