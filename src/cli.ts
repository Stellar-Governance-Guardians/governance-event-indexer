import { loadConfig, ConfigError } from './config.js';
import { withDatabase } from './db/index.js';
import { runMigrations } from './db/migrations/index.js';

/**
 * Operator CLI. Every command is non-interactive, deterministic and offline
 * with respect to the testnet (the PR gate never touches live RPC).
 *
 * Commands:
 *   migrate    apply all pending migrations to $DATABASE_URL (forward-only)
 */

const USAGE = `usage: node dist/cli.js <command>

commands:
  migrate    apply all pending migrations to $DATABASE_URL (forward-only)

environment:
  DATABASE_URL   required, postgres://... (never committed; see README)
  RPC_URL        optional, defaults to the public SDF testnet RPC
  PORT           optional, GraphQL/health port (default 4000)
`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '-h' || command === '--help') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === 'migrate') {
    const config = loadConfig();
    const { applied } = await withDatabase(config.databaseUrl, (db) => runMigrations(db));
    if (applied.length === 0) {
      process.stdout.write('migrate: already up to date\n');
    } else {
      process.stdout.write(`migrate: applied ${applied.join(', ')}\n`);
    }
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
    if (err instanceof ConfigError) {
      process.stderr.write(`config error: ${err.message}\n`);
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
