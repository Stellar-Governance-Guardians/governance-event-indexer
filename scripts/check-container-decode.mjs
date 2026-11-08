#!/usr/bin/env node
/**
 * Container smoke test (CI, docker only).
 *
 * Proves the runtime image can actually run the decoder: it connects to
 * $DATABASE_URL, reads the rows the replay step wrote, and fails unless
 *
 *   - the parser package is present in the image and ran at the pinned version,
 *   - every replayed event has a decoded_events row (no silent gaps),
 *   - the UNVERIFIED reason is the governor-shape miss, NOT a missing-module
 *     failure (which is what the image produced before generated/parser was
 *     copied into the runtime stage),
 *   - the decoding counts match exactly (per status, order-independent).
 *
 * It does NOT claim a VERIFIED decode: the replayed fixtures are SAC events, so
 * a correct decoder keeps them UNVERIFIED. The job name says "replays
 * fixtures", not "decodes a proposal", for that reason.
 *
 * `--self-test` exercises the comparison without a database: the same counts
 * in a different order must pass, and a wrong count must fail, so the check is
 * proven able to fail. A missing or unreadable dependency is a failure, never
 * a skip.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = JSON.parse(readFileSync(join(root, 'parser.lock'), 'utf8'));
const expected = JSON.parse(readFileSync(join(root, 'scripts', 'prove-indexer.expected.json'), 'utf8'));

/**
 * Compare decoding counts per status. Postgres does not guarantee `GROUP BY`
 * row order, so serialising the object and comparing strings would flake or
 * fail on equal data.
 */
export function compareDecoding(expectedCounts, observedCounts) {
  const failures = [];
  for (const [decoding, count] of Object.entries(expectedCounts)) {
    const observed = observedCounts[decoding] ?? 0;
    if (observed !== count) {
      failures.push(
        `expected ${count} ${decoding} rows, observed ${observed} ` +
          `(full: ${JSON.stringify(observedCounts)})`,
      );
    }
  }
  for (const decoding of Object.keys(observedCounts)) {
    if (!(decoding in expectedCounts)) {
      failures.push(
        `unexpected decoding status ${decoding} (full: ${JSON.stringify(observedCounts)})`,
      );
    }
  }
  return failures;
}

if (process.argv.includes('--self-test')) {
  const reordered = { UNVERIFIED: 2, VERIFIED: 0 };
  const accepted = compareDecoding(expected.decoding, reordered);
  const rejected = compareDecoding(expected.decoding, { VERIFIED: 0, UNVERIFIED: 1 });
  const unexpectedStatus = compareDecoding(expected.decoding, {
    VERIFIED: 0,
    UNVERIFIED: 2,
    DECODE_ERROR: 0,
  });
  if (accepted.length !== 0) {
    console.error(`self-test: reordered equal counts were rejected: ${accepted.join('; ')}`);
    process.exit(1);
  }
  if (rejected.length === 0) {
    console.error('self-test: a wrong count was accepted');
    process.exit(1);
  }
  if (unexpectedStatus.length === 0) {
    console.error('self-test: an unexpected status key was accepted');
    process.exit(1);
  }
  console.log(
    'check-container-decode self-test: PASS (order-independent; wrong counts and unknown statuses rejected)',
  );
  process.exit(0);
}

const { Client } = await import('pg');

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
failures.push(...compareDecoding(expected.decoding, observedStatuses));

await client.end();

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log(
  `check-container-decode: PASS (${expected.events} replayed events decoded at ${pin.version}; ` +
    'parser artifact present in the runtime image)',
);
