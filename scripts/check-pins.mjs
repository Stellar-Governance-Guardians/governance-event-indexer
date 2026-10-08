#!/usr/bin/env node
/**
 * Pin checker (interface contract: "CI fails on drift or unreachable pins").
 *
 * Modes:
 *   node scripts/check-pins.mjs            OFFLINE (PR gate): every vendored
 *     artifact must hash-match its lock file. Deterministic, network-free.
 *   node scripts/check-pins.mjs --online   NIGHTLY: additionally fetch each
 *     pinned upstream URL and require identical bytes (unreachable pin or
 *     upstream drift = failure). Never part of the PR gate.
 *
 * Exit code 0 = every applicable check passed. Failures print FAIL lines and
 * are never silently skipped (skips only happen in the claims ledger's tiers).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** sha256 of a file as lowercase hex. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readLock(name) {
  const path = join(ROOT, name);
  if (!existsSync(path)) return { error: `missing lock file: ${name}` };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { error: `${name} is not valid JSON: ${err.message}` };
  }
}

function requireKeys(lock, keys, label) {
  const missing = keys.filter(
    (k) => typeof lock[k] !== 'string' || lock[k].length === 0,
  );
  if (missing.length > 0) {
    return `${label} is missing/empty required key(s): ${missing.join(', ')}`;
  }
  return undefined;
}

/** Upstream URLs implied by the locks (derived, not stored — fewer fields to drift). */
export function pinnedUrls(locks) {
  const urls = [];
  for (const [label, lock, pathKey] of [
    ['schema', locks.schema, 'path'],
    ['registry', locks.registry, 'path'],
  ]) {
    const repo = lock.parserRepo.replace(/^https:\/\/github\.com\//, '');
    urls.push({
      label,
      url: `https://raw.githubusercontent.com/${repo}/${lock.commitSha}/${lock[pathKey]}`,
      sha256: lock.sha256,
    });
  }
  urls.push({ label: 'parser-wasm', url: locks.parser.assetUrl, sha256: locks.parser.sha256 });
  return urls;
}

/**
 * Run all applicable checks. Returns { results: [{id, ok, detail}], mode }.
 * Pure enough to unit-test: the online path takes an injectable fetch.
 */
export async function checkPins({ online = false, fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  const add = (id, ok, detail) => results.push({ id, ok, detail });

  const schema = readLock('schema.lock');
  const registry = readLock('registry.lock');
  const parser = readLock('parser.lock');
  for (const [name, r] of [
    ['schema.lock', schema],
    ['registry.lock', registry],
    ['parser.lock', parser],
  ]) {
    if (r.error) add(`lock-parse:${name}`, false, r.error);
  }
  if (schema.error || registry.error || parser.error) return { results, mode: online ? 'online' : 'offline' };

  const s = schema.value;
  const r = registry.value;
  const p = parser.value;

  add(
    'schema.lock:keys',
    requireKeys(s, ['parserRepo', 'commitSha', 'path', 'sha256'], 'schema.lock') === undefined,
    requireKeys(s, ['parserRepo', 'commitSha', 'path', 'sha256'], 'schema.lock') ?? 'keys present',
  );
  add(
    'registry.lock:keys',
    requireKeys(r, ['parserRepo', 'commitSha', 'path', 'sha256'], 'registry.lock') === undefined,
    requireKeys(r, ['parserRepo', 'commitSha', 'path', 'sha256'], 'registry.lock') ?? 'keys present',
  );
  add(
    'parser.lock:keys',
    requireKeys(p, ['version', 'assetUrl', 'sha256'], 'parser.lock') === undefined,
    requireKeys(p, ['version', 'assetUrl', 'sha256'], 'parser.lock') ?? 'keys present',
  );

  // sha256 shape (64 lowercase hex) — a malformed hash fails closed.
  for (const [label, lock] of [
    ['schema.lock', s],
    ['registry.lock', r],
    ['parser.lock', p],
  ]) {
    const ok = /^[0-9a-f]{64}$/.test(lock.sha256 ?? '');
    add(`${label}:sha256-format`, ok, ok ? '64 hex chars' : `not a lowercase sha256: ${lock.sha256}`);
  }

  // Offline: vendored bytes must hash-match the lock.
  const vendored = [
    ['schema/governance-v1.graphql', s, 'schema'],
    ['deployments.json', r, 'registry'],
    [`vendor/${(p.assetUrl ?? '').split('/').pop()}`, p, 'parser-wasm'],
  ];
  for (const [rel, lock, id] of vendored) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      add(`vendored:${id}`, false, `missing vendored artifact: ${rel}`);
      continue;
    }
    const actual = sha256File(path);
    const ok = actual === lock.sha256;
    add(
      `vendored:${id}`,
      ok,
      ok
        ? `${rel} sha256 matches (${actual})`
        : `DRIFT: ${rel} sha256 ${actual} != lock ${lock.sha256}`,
    );
  }

  if (online) {
    if (typeof fetchImpl !== 'function') {
      add('online:fetch', false, 'no fetch implementation available');
    } else {
      for (const { label, url, sha256 } of pinnedUrls({ schema: s, registry: r, parser: p })) {
        try {
          const res = await fetchImpl(url, { redirect: 'follow' });
          if (!res.ok) {
            add(`online:${label}`, false, `UNREACHABLE: HTTP ${res.status} for ${url}`);
            continue;
          }
          const bytes = Buffer.from(await res.arrayBuffer());
          const actual = sha256Bytes(bytes);
          const ok = actual === sha256;
          add(
            `online:${label}`,
            ok,
            ok ? `resolves, sha256 matches (${url})` : `UPSTREAM DRIFT: ${url} sha256 ${actual} != lock ${sha256}`,
          );
        } catch (err) {
          add(`online:${label}`, false, `UNREACHABLE: ${url} (${err.message})`);
        }
      }
    }
  }

  return { results, mode: online ? 'online' : 'offline' };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const online = process.argv.includes('--online');
  const { results } = await checkPins({ online });
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`PASS  ${r.id}: ${r.detail}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${r.id}: ${r.detail}`);
    }
  }
  console.log(`check-pins (${online ? 'online' : 'offline'}): ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}
