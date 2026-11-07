#!/usr/bin/env node
/**
 * GraphQL half of scripts/prove-indexer.
 *
 * Queries the running endpoint with the real keyset-paginated `events` query,
 * follows every page, and compares the result with
 * scripts/prove-indexer.expected.json. Writes the raw responses plus the
 * comparison to prove/indexer-proof.json (gitignored) and exits non-zero on any
 * mismatch. No network beyond INDEXER_URL; no fixture is imported here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const expected = JSON.parse(readFileSync(join(root, 'scripts', 'prove-indexer.expected.json'), 'utf8'));
const endpoint = process.argv[2] ?? 'http://127.0.0.1:4000/graphql';

const QUERY = `query ProveEvents($first: Int, $after: String) {
  events(first: $first, after: $after) {
    edges { cursor node { governor ledger txHash contractId decoding payload } }
    pageInfo { hasNextPage endCursor }
  }
}`;

async function gql(first, after) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, operationName: 'ProveEvents', variables: { first, after } }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`cannot reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`${endpoint} responded HTTP ${response.status}`);
  const body = await response.json();
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  return body;
}

const pages = [];
const nodes = [];
let after = null;
for (let guard = 0; guard < 100; guard += 1) {
  const body = await gql(50, after);
  pages.push(body);
  for (const edge of body.data.events.edges) nodes.push(edge.node);
  if (!body.data.events.pageInfo.hasNextPage) break;
  after = body.data.events.pageInfo.endCursor;
  if (after === null) throw new Error('hasNextPage is true but endCursor is null');
}

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

const decoding = { VERIFIED: 0, UNVERIFIED: 0 };
const governors = {};
for (const node of nodes) {
  decoding[node.decoding] = (decoding[node.decoding] ?? 0) + 1;
  governors[node.governor] = (governors[node.governor] ?? 0) + 1;
}

expect(nodes.length === expected.events, `expected ${expected.events} events, got ${nodes.length}`);
expect(
  decoding.VERIFIED === expected.decoding.VERIFIED && decoding.UNVERIFIED === expected.decoding.UNVERIFIED,
  `expected decoding ${JSON.stringify(expected.decoding)}, got ${JSON.stringify(decoding)}`,
);
expect(
  JSON.stringify(governors) === JSON.stringify(expected.governors),
  `expected governors ${JSON.stringify(expected.governors)}, got ${JSON.stringify(governors)}`,
);
expect(
  JSON.stringify(nodes.map((n) => n.ledger)) === JSON.stringify(expected.ledgers),
  `expected ledgers ${JSON.stringify(expected.ledgers)}, got ${JSON.stringify(nodes.map((n) => n.ledger))}`,
);
expect(
  nodes.every((n) => n.contractId === expected.contractId),
  `expected contractId ${expected.contractId}, got ${JSON.stringify(nodes.map((n) => n.contractId))}`,
);
expect(
  nodes.every((n) => n.payload?.source === expected.source),
  `expected payload.source ${expected.source} on every row, got ${JSON.stringify(nodes.map((n) => n.payload?.source))}`,
);
expect(
  nodes.every((n) => n.payload?.reason === expected.unverifiedReason),
  `expected UNVERIFIED reason "${expected.unverifiedReason}" on every row, got ${JSON.stringify(nodes.map((n) => n.payload?.reason))}`,
);

mkdirSync(join(root, 'prove'), { recursive: true });
writeFileSync(
  join(root, 'prove', 'indexer-proof.json'),
  `${JSON.stringify({ endpoint, checkedAtUtc: new Date().toISOString(), expected, observed: { decoding, governors, nodes }, pages, failures }, null, 2)}\n`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`prove-indexer: ${failures.length} assertion(s) failed (see prove/indexer-proof.json)`);
  process.exit(1);
}
console.log(`prove-indexer: PASS (${nodes.length} events, ${decoding.UNVERIFIED} UNVERIFIED, 0 VERIFIED as expected)`);
