import { mkdtempSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractContractEntries, loadRegistry, RegistryError } from '../../src/registry/index.js';

/** Copy the real pinned files into a temp root so tampering stays out of git. */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-test-'));
  cpSync('registry.lock', join(dir, 'registry.lock'));
  cpSync('deployments.json', join(dir, 'deployments.json'));
  return dir;
}

describe('extractContractEntries', () => {
  it('flattens groups and single entries from the real deployments.json', () => {
    const doc: unknown = JSON.parse(readFileSync('deployments.json', 'utf8'));
    const entries = extractContractEntries(doc);
    const ids = entries.map((e) => e.name);
    expect(ids).toContain('fixtureGovernor');
    expect(ids).toContain('seedV2Script3.script3Governor');
    expect(ids).toContain('seedV2OpenZeppelin.ozGovernor');
    for (const e of entries) expect(e.contractId).toMatch(/^C[A-Z2-7]{55}$/);
    // $comment keys never become entries
    expect(ids.some((n) => n.includes('$comment'))).toBe(false);
    expect(entries.some((e) => e.fromOverride)).toBe(false);
  });

  it('fails loud on malformed shapes', () => {
    expect(() => extractContractEntries(null)).toThrow(/not an object/);
    expect(() => extractContractEntries({})).toThrow(/missing "contracts"/);
    expect(() => extractContractEntries({ contracts: {} })).toThrow(/missing "contracts.testnet"/);
    expect(() =>
      extractContractEntries({ contracts: { testnet: { g: { entry: {} } } } }),
    ).toThrow(/has no contractId/);
    expect(() => extractContractEntries({ contracts: { testnet: {} } })).toThrow(
      /no contract entries/,
    );
  });
});

describe('loadRegistry', () => {
  it('loads the pinned registry and hash-verifies it', () => {
    const registry = loadRegistry({ root: process.cwd() });
    expect(registry.entries.length).toBeGreaterThanOrEqual(8);
    expect(registry.lock.commitSha).toBe('ba3bf1a3ee7525215f3d3e919974f8b7fbaf0b74');
    expect(registry.declaredRetentionWindow).toBe(120960);
  });

  it('adds env-override contracts and de-duplicates', () => {
    const first = loadRegistry({ root: process.cwd() }).entries[0]!.contractId;
    // Synthetic, well-formed, NOT present in deployments.json.
    const overrideId = `C${'A'.repeat(55)}`;
    const registry = loadRegistry({ root: process.cwd(), override: [overrideId, first] });
    expect(registry.entries.filter((e) => e.fromOverride).map((e) => e.contractId)).toEqual([
      overrideId,
    ]);
  });

  it('rejects invalid override ids (fail closed)', () => {
    expect(() => loadRegistry({ root: process.cwd(), override: ['not-a-contract'] })).toThrow(
      RegistryError,
    );
    expect(() => loadRegistry({ root: process.cwd(), override: ['not-a-contract'] })).toThrow(
      /contract id is invalid/,
    );
  });

  it('detects drift: a tampered vendored registry fails to load', () => {
    const dir = tempRoot();
    const path = join(dir, 'deployments.json');
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const contracts = doc['contracts'] as Record<string, Record<string, Record<string, unknown>>>;
    const fixture = contracts['testnet']!['fixtureGovernor']!;
    fixture['contractId'] = 'CDJWPKSQ4NA67PKTNJEPI6R2Q3JEDXPX5EDPM3YOSEHBDGBZ5THBTOKE2';
    writeFileSync(path, JSON.stringify(doc, null, 2));
    expect(() => loadRegistry({ root: dir })).toThrow(/registry drift/);
  });

  it('fails loud when the pin exists but the vendored file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-missing-'));
    cpSync('registry.lock', join(dir, 'registry.lock'));
    expect(() => loadRegistry({ root: dir })).toThrow(/vendored registry missing/);
  });

  it('fails loud on a malformed lock file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-badlock-'));
    writeFileSync(join(dir, 'registry.lock'), JSON.stringify({ parserRepo: 'x' }));
    cpSync('deployments.json', join(dir, 'deployments.json'));
    expect(() => loadRegistry({ root: dir })).toThrow(/cannot read registry.lock/);
  });
});
