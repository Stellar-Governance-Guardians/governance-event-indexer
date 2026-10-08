import { describe, expect, it } from 'vitest';
import { checkPins, pinnedUrls, sha256Bytes } from '../../scripts/check-pins.mjs';

/**
 * Pin checker tests (I1). Offline mode must pass against the real vendored
 * artifacts, detect tampering via the injectable fetch in online mode, and
 * report unreachable pins as failures — never as passes.
 */
describe('check-pins offline', () => {
  it('passes against the committed pins', async () => {
    const { results, mode } = await checkPins();
    expect(mode).toBe('offline');
    const failed = results.filter((r) => !r.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(9);
  });
});

describe('check-pins online (injected fetch)', () => {
  it('passes when upstream bytes match the locks', async () => {
    const { results } = await checkPins({
      online: true,
      fetchImpl: async (url) => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const local =
          url.includes('governance-v1.graphql')
            ? join(process.cwd(), 'schema/governance-v1.graphql')
            : url.includes('deployments.json')
              ? join(process.cwd(), 'deployments.json')
              : join(process.cwd(), 'vendor/sgg-parser-wasm-0.1.0-alpha.1.tgz');
        return new Response(readFileSync(local));
      },
    });
    const online = results.filter((r) => r.id.startsWith('online:'));
    expect(online).toHaveLength(3);
    expect(online.filter((r) => !r.ok)).toEqual([]);
  });

  it('fails loud on upstream drift (same URL, different bytes)', async () => {
    const { results } = await checkPins({
      online: true,
      fetchImpl: async () => new Response(Buffer.from('tampered upstream bytes')),
    });
    const drifted = results.filter((r) => r.id.startsWith('online:') && !r.ok);
    expect(drifted).toHaveLength(3);
    expect(drifted.every((r) => r.detail.includes('UPSTREAM DRIFT'))).toBe(true);
  });

  it('fails loud on an unreachable pin (HTTP 404)', async () => {
    const { results } = await checkPins({
      online: true,
      fetchImpl: async () => new Response('gone', { status: 404 }),
    });
    const unreachable = results.filter((r) => r.id.startsWith('online:') && !r.ok);
    expect(unreachable).toHaveLength(3);
    expect(unreachable.every((r) => r.detail.includes('UNREACHABLE'))).toBe(true);
  });

  it('fails loud when fetch throws (network down)', async () => {
    const { results } = await checkPins({
      online: true,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(results.filter((r) => r.id.startsWith('online:') && !r.ok)).toHaveLength(3);
  });
});

describe('pinnedUrls derivation', () => {
  it('derives raw.githubusercontent URLs from parserRepo + commitSha + path', async () => {
    const { readFileSync } = await import('node:fs');
    const schema = JSON.parse(readFileSync('schema.lock', 'utf8'));
    const registry = JSON.parse(readFileSync('registry.lock', 'utf8'));
    const parser = JSON.parse(readFileSync('parser.lock', 'utf8'));
    const urls = pinnedUrls({ schema, registry, parser });
    expect(urls).toHaveLength(3);
    const [rawSchema, rawRegistry, asset] = urls;
    expect(rawSchema?.url).toBe(
      `https://raw.githubusercontent.com/Stellar-Governance-Guardians/soroban-governance-parser/${schema.commitSha}/schemas/governance-v1.graphql`,
    );
    expect(rawRegistry?.url).toContain(`/${registry.commitSha}/deployments.json`);
    expect(asset?.url).toBe(parser.assetUrl);
    for (const u of urls) expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sha256Bytes is stable for a known vector', () => {
    // sha256("abc")
    expect(sha256Bytes(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
