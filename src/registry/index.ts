import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CONTRACT_ID_RE } from '../config.js';

/**
 * Governor registry (I2): the pinned copy of the parser's deployments.json
 * (see registry.lock), extended at runtime only by an explicit env override.
 *
 * Fail-closed rules:
 * - the vendored file must hash-match registry.lock on every load (drift is a
 *   loud error, not a warning);
 * - contract ids are validated (strkey) whether they come from the file or
 *   the override;
 * - the file shape is validated: every registry entry must carry a contractId.
 */

export interface RegistryLock {
  parserRepo: string;
  commitSha: string;
  path: string;
  sha256: string;
}

export interface RegistryEntry {
  /** Dotted path inside deployments.json, e.g. `seedV2Script3.script3Governor`. */
  readonly name: string;
  readonly contractId: string;
  /** Free-text role from deployments.json, if present. */
  readonly role: string | undefined;
  /** true when the entry arrived via GOVERNOR_REGISTRY_OVERRIDE instead of the file. */
  readonly fromOverride: boolean;
}

export interface GovernorRegistry {
  readonly entries: readonly RegistryEntry[];
  readonly lock: RegistryLock;
  /** ledgerRetentionWindow as recorded in deployments.json (informational). */
  readonly declaredRetentionWindow: number | undefined;
}

export class RegistryError extends Error {
  override readonly name = 'RegistryError';
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Flatten `contracts.testnet` from deployments.json. Shape: groups of entries
 * (`seedV2Script3.script3Governor`) plus top-level single entries
 * (`fixtureGovernor`), with `$comment` keys everywhere — all skipped.
 */
export function extractContractEntries(doc: unknown): RegistryEntry[] {
  if (!isRecord(doc)) throw new RegistryError('deployments.json root is not an object');
  const contracts = doc['contracts'];
  if (!isRecord(contracts)) throw new RegistryError('deployments.json: missing "contracts"');
  const testnet = contracts['testnet'];
  if (!isRecord(testnet)) throw new RegistryError('deployments.json: missing "contracts.testnet"');

  const entries: RegistryEntry[] = [];
  for (const [group, value] of Object.entries(testnet)) {
    if (group === '$comment' || !isRecord(value)) continue;
    if (typeof value['contractId'] === 'string') {
      entries.push({ name: group, contractId: value['contractId'], role: typeof value['role'] === 'string' ? value['role'] : undefined, fromOverride: false });
      continue;
    }
    for (const [name, sub] of Object.entries(value)) {
      if (name === '$comment' || !isRecord(sub)) continue;
      if (typeof sub['contractId'] !== 'string') {
        throw new RegistryError(`deployments.json: entry ${group}.${name} has no contractId`);
      }
      entries.push({
        name: `${group}.${name}`,
        contractId: sub['contractId'],
        role: typeof sub['role'] === 'string' ? sub['role'] : undefined,
        fromOverride: false,
      });
    }
  }
  if (entries.length === 0) throw new RegistryError('deployments.json: no contract entries found');
  return entries;
}

export interface LoadRegistryOptions {
  /** Path to the vendored registry file (default: deployments.json at repo root). */
  deploymentsPath?: string;
  /** Path to registry.lock (default: registry.lock at repo root). */
  lockPath?: string;
  /** Contract ids from GOVERNOR_REGISTRY_OVERRIDE (already validated). */
  override?: readonly string[];
  /** Repo root; injectable for tests. */
  root?: string;
}

export function loadRegistry(options: LoadRegistryOptions = {}): GovernorRegistry {
  const root = options.root ?? process.cwd();
  const lockPath = options.lockPath ?? `${root}/registry.lock`;
  const deploymentsPath = options.deploymentsPath ?? `${root}/deployments.json`;

  let lock: RegistryLock;
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('root is not an object');
    for (const k of ['parserRepo', 'commitSha', 'path', 'sha256']) {
      if (typeof parsed[k] !== 'string' || parsed[k] === '') {
        throw new Error(`missing key ${k}`);
      }
    }
    lock = parsed as unknown as RegistryLock;
  } catch (err) {
    throw new RegistryError(`cannot read registry.lock: ${err instanceof Error ? err.message : String(err)}`);
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(deploymentsPath);
  } catch {
    throw new RegistryError(`vendored registry missing: ${deploymentsPath} (pin not materialized)`);
  }
  const actual = sha256(bytes);
  if (actual !== lock.sha256) {
    throw new RegistryError(
      `registry drift: sha256(${deploymentsPath}) = ${actual}, registry.lock = ${lock.sha256}. ` +
        'Re-vendor via a pin-bump PR; never edit the vendored file in place.',
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new RegistryError(`deployments.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const entries = extractContractEntries(doc);
  for (const e of entries) {
    if (!CONTRACT_ID_RE.test(e.contractId)) {
      throw new RegistryError(`deployments.json entry ${e.name} has invalid contract id: ${e.contractId}`);
    }
  }

  const overrideIds = options.override ?? [];
  const seen = new Set(entries.map((e) => e.contractId));
  for (const id of overrideIds) {
    if (!CONTRACT_ID_RE.test(id)) {
      throw new RegistryError(`override contract id is invalid: ${id}`);
    }
    if (!seen.has(id)) {
      entries.push({ name: `override:${id}`, contractId: id, role: undefined, fromOverride: true });
      seen.add(id);
    }
  }

  const networks = isRecord(doc) ? doc['networks'] : undefined;
  const retention = isRecord(networks) ? networks['testnet'] : undefined;
  const declaredRetentionWindow =
    isRecord(retention) && typeof retention['ledgerRetentionWindow'] === 'number'
      ? (retention['ledgerRetentionWindow'] as number)
      : undefined;

  return { entries, lock, declaredRetentionWindow };
}
