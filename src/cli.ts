import { loadConfig, ConfigError } from './config.js';
import { withDatabase } from './db/index.js';
import { runMigrations } from './db/migrations/index.js';
import { ingestCatchUp } from './ingest/run.js';
import { loadRegistry, RegistryError } from './registry/index.js';
import { createRpcClient, RpcError } from './rpc/client.js';
import { replayFixtureDir, ReplayError } from './replay/run.js';

/**
 * Operator CLI. Commands are non-interactive; the ingestion/replay commands
 * only ever talk to the testnet when you run them explicitly — the PR gate
 * never invokes them (charter/process rule: offline, deterministic PR gate).
 *
 * Commands:
 *   migrate              apply all pending migrations (forward-only)
 *   ingest [--once]      catch up raw_events from the RPC for every
 *                        registered contract (windows <= 1000 ledgers)
 *   replay <dir> [--allow-unregistered]
 *                        replay committed raw getEvents fixtures through the
 *                        same code path, tagged source=fixture-replay.
 *                        Never touches cursors.
 */

const USAGE = `usage: node dist/cli.js <command> [args]

commands:
  migrate                        apply all pending migrations to $DATABASE_URL (forward-only)
  ingest [--once]                ingest raw events from the RPC for every registered
                                 contract; --once stops after one window per contract
  replay <dir> [--allow-unregistered]
                                 replay committed raw getEvents *.json fixtures through
                                 the same normalization path (source=fixture-replay);
                                 does not read or advance ingest cursors

environment:
  DATABASE_URL              required, postgres://... (never committed; see README)
  RPC_URL                   optional, defaults to the public SDF testnet RPC
  PORT                      optional, GraphQL/health port (default 4000)
  GOVERNOR_REGISTRY_OVERRIDE  optional, comma-separated extra contract ids
  INGEST_WINDOW_LEDGERS     optional, <= 1000 (default 1000)
`;

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === 'migrate') {
    const config = loadConfig();
    const { applied } = await withDatabase(config.databaseUrl, (db) => runMigrations(db));
    process.stdout.write(
      applied.length === 0 ? 'migrate: already up to date\n' : `migrate: applied ${applied.join(', ')}\n`,
    );
    return 0;
  }

  if (command === 'ingest') {
    const config = loadConfig();
    const registry = loadRegistry({ override: config.governorRegistryOverride });
    const rpc = createRpcClient(config.rpcUrl);
    const report = await withDatabase(config.databaseUrl, async (db) => {
      await runMigrations(db);
      return ingestCatchUp(db, rpc, registry, {
        windowLedgers: config.ingestWindowLedgers,
        once: hasFlag(argv, '--once'),
      });
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const gaps = report.contracts.filter((c) => c.gap !== undefined);
    if (gaps.length > 0) {
      process.stderr.write(
        `ingest: WARNING — ${gaps.length} retention gap(s) recorded; /health will report them (never skipped silently)\n`,
      );
    }
    return 0;
  }

  if (command === 'replay') {
    const dir = argv.slice(1).find((a) => !a.startsWith('--'));
    if (dir === undefined) {
      process.stderr.write(`error: replay requires a fixture directory\n\n${USAGE}`);
      return 1;
    }
    const config = loadConfig();
    const registry = loadRegistry({ override: config.governorRegistryOverride });
    const outcomes = await withDatabase(config.databaseUrl, async (db) => {
      await runMigrations(db);
      return replayFixtureDir(db, dir, registry, {
        allowUnregistered: hasFlag(argv, '--allow-unregistered'),
      });
    });
    process.stdout.write(`${JSON.stringify(outcomes, null, 2)}\n`);
    const total = outcomes.reduce((n, o) => n + o.events, 0);
    const inserted = outcomes.reduce((n, o) => n + o.inserted, 0);
    process.stdout.write(`replay: ${total} events, ${inserted} newly inserted (source=fixture-replay)\n`);
    return 0;
  }

  process.stderr.write(`error: unknown command "${command}"\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const known = [ConfigError, RegistryError, ReplayError, RpcError];
    const match = known.find((C) => err instanceof C);
    if (match !== undefined) {
      process.stderr.write(`${match.name}: ${(err as Error).message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
      if (err.cause !== undefined) {
        process.stderr.write(`cause: ${String(err.cause)}\n`);
      }
    } else {
      process.stderr.write(`error: ${String(err)}\n`);
    }
    process.exitCode = 1;
  });
