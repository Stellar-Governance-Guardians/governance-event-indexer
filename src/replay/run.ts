/**
 * Fixture replay (I2): re-plays committed raw getEvents responses through the
 * EXACT same normalization + insert path as live ingestion, tagging rows
 * source='fixture-replay'. This is how history older than the RPC retention
 * window enters the database — never silently, always distinguishable from
 * source='live' rows in every API response.
 *
 * Charter rule 1 nuance: this is the replay COMMAND (explicitly allowed to
 * read fixtures). It contains no fixture paths — the operator passes the
 * directory — so the live path and `src/` stay fixture-string-free (CI grep).
 * Cursors are never read or written here: replay cannot move live progress.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Kysely } from 'kysely';
import type { Database } from '../db/index.js';
import type { GovernorRegistry } from '../registry/index.js';
import { parseGetEventsResult } from '../rpc/client.js';
import { toRawEventRow } from '../ingest/normalize.js';
import { insertRawEvents } from '../ingest/store.js';

export class ReplayError extends Error {
  override readonly name = 'ReplayError';
}

export interface ReplayFileOutcome {
  file: string;
  /** Events in the fixture. */
  events: number;
  /** Rows newly inserted (rest were already present — idempotent). */
  inserted: number;
  /** Contracts kept out of the run because they are not registered. */
  skippedUnregistered: string[];
}

export interface ReplayOptions {
  /** Proceed even if a fixture references a contract outside the registry. */
  allowUnregistered?: boolean;
}

function parseFixture(raw: string, file: string): ReturnType<typeof parseGetEventsResult> {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new ReplayError(`${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new ReplayError(`${file}: expected a JSON-RPC response object`);
  }
  const result = (doc as { result?: unknown }).result;
  if (result === undefined) {
    throw new ReplayError(`${file}: missing "result" — not a raw getEvents response`);
  }
  return parseGetEventsResult(result);
}

export async function replayFixtureFile(
  db: Kysely<Database>,
  filePath: string,
  registry: GovernorRegistry,
  options: ReplayOptions = {},
): Promise<ReplayFileOutcome> {
  let bytes: string;
  try {
    bytes = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ReplayError(`${filePath}: cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = parseFixture(bytes, filePath);
  const registered = new Set(registry.entries.map((e) => e.contractId));

  const skipped = new Set<string>();
  const rows = [];
  for (const event of parsed.events) {
    if (!registered.has(event.contractId)) {
      if (options.allowUnregistered !== true) {
        throw new ReplayError(
          `${filePath}: event for unregistered contract ${event.contractId}. ` +
            'Add it via GOVERNOR_REGISTRY_OVERRIDE or pass allowUnregistered explicitly — ' +
            'replay never stores events for contracts outside the pinned registry silently.',
        );
      }
      skipped.add(event.contractId);
      continue;
    }
    rows.push(toRawEventRow(event, 'fixture-replay'));
  }

  const inserted = await insertRawEvents(db, rows);
  return {
    file: filePath,
    events: parsed.events.length,
    inserted,
    skippedUnregistered: [...skipped],
  };
}

/** Replay every `*.json` in a directory, sorted (deterministic order). */
export async function replayFixtureDir(
  db: Kysely<Database>,
  dir: string,
  registry: GovernorRegistry,
  options: ReplayOptions = {},
): Promise<ReplayFileOutcome[]> {
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    throw new ReplayError(`replay directory does not exist: ${dir}`);
  }
  if (!stat.isDirectory()) throw new ReplayError(`replay path is not a directory: ${dir}`);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(dir, f));
  if (files.length === 0) {
    throw new ReplayError(`replay directory has no .json fixtures: ${dir}`);
  }

  const outcomes: ReplayFileOutcome[] = [];
  for (const file of files) {
    outcomes.push(await replayFixtureFile(db, file, registry, options));
  }
  return outcomes;
}
