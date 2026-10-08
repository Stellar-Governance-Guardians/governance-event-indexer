/**
 * Runtime configuration.
 *
 * Charter rule 2 (fail closed, fail loud): a missing or malformed setting is
 * an explicit ConfigError — never a silent default for anything that points
 * at real infrastructure. Charter rule 5: DATABASE_URL is runtime
 * configuration from env / Codespaces secrets, never committed to git.
 */

export interface Config {
  /** Postgres connection string. Required; no default. */
  readonly databaseUrl: string;
  /** Soroban JSON-RPC endpoint. */
  readonly rpcUrl: string;
  /** HTTP port for the GraphQL API + /health. */
  readonly port: number;
  /** Extra contract IDs beyond the pinned registry (env override, I2). */
  readonly governorRegistryOverride: string[];
  /** getEvents window size in ledgers. Hard-capped at MAX_WINDOW_LEDGERS. */
  readonly ingestWindowLedgers: number;
}

/** Public SDF testnet RPC (deployments.json network entry, same endpoint). */
export const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
export const DEFAULT_PORT = 4000;
/** Public RPC times out on wider ranges (parser SPEC ground truth). */
export const MAX_WINDOW_LEDGERS = 1000;
export const DEFAULT_WINDOW_LEDGERS = 1000;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export type Env = Record<string, string | undefined>;

const POSTGRES_SCHEME = /^postgres(ql)?:\/\/\S+$/;

/**
 * DATABASE_URL is mandatory for every command that touches the database.
 * We validate the scheme so a copy-pasted `http://` URL fails at startup
 * with a clear message instead of deep inside the driver.
 */
export function requireDatabaseUrl(env: Env): string {
  const raw = env['DATABASE_URL'];
  if (raw === undefined || raw === '') {
    throw new ConfigError(
      'DATABASE_URL is not set. Provide it via the environment ' +
        '(Codespaces secret / exported var). It is never committed to git.',
    );
  }
  if (!POSTGRES_SCHEME.test(raw)) {
    throw new ConfigError(
      `DATABASE_URL must look like postgres://... or postgresql://... (got a ${raw.length}-char value that does not match).`,
    );
  }
  return raw;
}

export function parsePort(env: Env): number {
  const raw = env['PORT'];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535 (got "${raw}").`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be between 1 and 65535 (got ${port}).`);
  }
  return port;
}

export function parseRpcUrl(env: Env): string {
  const raw = env['RPC_URL'];
  if (raw === undefined || raw === '') return DEFAULT_RPC_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`RPC_URL is not a valid URL (got "${raw}").`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`RPC_URL must be http(s) (got "${url.protocol}").`);
  }
  return raw;
}

/**
 * Contract ids are strkeys: C + 55 base32 chars (56 total). Validated eagerly
 * so a typo in the override fails at startup, not as a silently empty result
 * set.
 */
export const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export function parseRegistryOverride(env: Env): string[] {
  const raw = env['GOVERNOR_REGISTRY_OVERRIDE'];
  if (raw === undefined || raw.trim() === '') return [];
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const bad = ids.filter((id) => !CONTRACT_ID_RE.test(id));
  if (bad.length > 0) {
    throw new ConfigError(
      `GOVERNOR_REGISTRY_OVERRIDE contains invalid contract id(s): ${bad.join(', ')}. ` +
        'Expected comma-separated strkey contract ids (C + 55 base32 chars).',
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new ConfigError('GOVERNOR_REGISTRY_OVERRIDE contains duplicate contract ids.');
  }
  return ids;
}

export function parseWindowLedgers(env: Env): number {
  const raw = env['INGEST_WINDOW_LEDGERS'];
  if (raw === undefined || raw === '') return DEFAULT_WINDOW_LEDGERS;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`INGEST_WINDOW_LEDGERS must be a positive integer (got "${raw}").`);
  }
  const n = Number(raw);
  if (n < 1 || n > MAX_WINDOW_LEDGERS) {
    throw new ConfigError(
      `INGEST_WINDOW_LEDGERS must be between 1 and ${MAX_WINDOW_LEDGERS} — the public RPC ` +
        'times out on wider ledger ranges (never widen silently).',
    );
  }
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    databaseUrl: requireDatabaseUrl(env),
    rpcUrl: parseRpcUrl(env),
    port: parsePort(env),
    governorRegistryOverride: parseRegistryOverride(env),
    ingestWindowLedgers: parseWindowLedgers(env),
  };
}
