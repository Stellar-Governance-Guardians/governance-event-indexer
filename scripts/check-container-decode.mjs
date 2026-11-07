#!/usr/bin/env node
/**
 * Container smoke test (CI, docker only).
 *
 * Proves the runtime image can actually decode: it connects to $DATABASE_URL,
 * reads the rows the replay step wrote, and fails unless
 *
 *   - the parser package is present in the image and ran at the pinned version,
 *   - every replayed event has a decoded_events row (no silent gaps),
 *   - the UNVERIFIED reason is the governor-shape miss, NOT a missing-module
 *     failure (which is what the image produced before generated/parser was
 *     copied into the runtime stage).
 *
 * A missing or unreadable dependency is a failure, never a skip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Client } from 'pg';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(root, 'parser.lock'), 'utf8'));
const expected = JSON.parse(readFileSync(join(root, 'scripts', 'prove-indexer.expected.json'), 'utf8'));

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('check-container-decode: FAIL: DATABASE_URL is not set');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const failures = [];

const raw = await client.query('SELECT count(*)::int AS n FROM raw_events');
if (raw.rows[0].n !== expected.events) {
  failures.push(`raw_events has ${raw.rows[0].n} rows, expected ${expected.events}`);
}

const decoded = await client.query(
  'SELECT count(*)::int AS n FROM decoded_events WHERE parser_version = $1',
  [pin.version],
);
if (decoded.rows[0].n !== expected.events) {
  failures.push(
    `decoded_events has ${decoded.rows[0].n} rows at parser_version ${pin.version}, expected ${expected.events}`,
  );
}

const reasons = await client.query(
  "SELECT count(*)::int AS n FROM decoded_events WHERE payload->>'reason' = $1",
  [expected.unverifiedReason],
);
if (reasons.rows[0].n !== expected.events) {
  const observed = await client.query("SELECT DISTINCT payload->>'reason' AS reason FROM decoded_events");
  failures.push(
    `expected ${expected.events} rows with reason "${expected.unverifiedReason}", observed: ` +
      JSON.stringify(observed.rows.map((r) => r.reason)),
  );
}

const statuses = await client.query('SELECT decoding, count(*)::int AS n FROM decoded_events GROUP BY decoding');
const observedStatuses = Object.fromEntries(statuses.rows.map((r) => [r.decoding, r.n]));
if (JSON.stringify(observedStatuses) !== JSON.stringify(expected.decoding)) {
  failures.push(`expected decoding ${JSON.stringify(expected.decoding)}, got ${JSON.stringify(observedStatuses)}`);
}

await client.end();

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(
  `check-container-decode: PASS (${expected.events} events decoded at ${pin.version}; ` +
    'parser artifact present in the runtime image)',
);
