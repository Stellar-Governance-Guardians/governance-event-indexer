import { describe, expect, it } from 'vitest';
import { createHealthCache } from '../../src/rpc/health-cache.js';
import type { HealthResult } from '../../src/rpc/client.js';

const HEALTH: HealthResult = {
  status: 'healthy',
  latestLedger: 1_000,
  oldestLedger: 900,
  ledgerRetentionWindow: 100,
};

function countingRpc(result: () => Promise<HealthResult>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    getHealth: () => {
      calls += 1;
      return result();
    },
  };
}

describe('health cache', () => {
  it('serves one RPC read for repeated requests inside the TTL', async () => {
    let now = 1_000;
    const rpc = countingRpc(async () => HEALTH);
    const cache = createHealthCache(rpc, 5_000, () => now);

    const first = await cache.get();
    now += 4_999;
    const second = await cache.get();

    expect(rpc.calls).toBe(1);
    expect(first.ageMs).toBe(0);
    expect(second.ageMs).toBe(4_999);
    expect(second.observedAt).toBe(new Date(1_000).toISOString());
  });

  it('refreshes once the TTL has elapsed', async () => {
    let now = 0;
    const rpc = countingRpc(async () => ({ ...HEALTH, latestLedger: HEALTH.latestLedger + rpc.calls }));
    const cache = createHealthCache(rpc, 1_000, () => now);

    await cache.get();
    now += 1_000;
    const refreshed = await cache.get();

    expect(rpc.calls).toBe(2);
    expect(refreshed.ageMs).toBe(0);
  });

  it('dedupes concurrent reads into one RPC call', async () => {
    const rpc = countingRpc(async () => HEALTH);
    const cache = createHealthCache(rpc, 5_000, () => 0);

    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(rpc.calls).toBe(1);
    expect(a).toEqual(b);
  });

  it('never caches a failure', async () => {
    let fail = true;
    const rpc = countingRpc(async () => {
      if (fail) throw new Error('RPC is down');
      return HEALTH;
    });
    const cache = createHealthCache(rpc, 5_000, () => 0);

    await expect(cache.get()).rejects.toThrow(/RPC is down/);
    fail = false;
    await expect(cache.get()).resolves.toMatchObject({ status: 'healthy' });
    expect(rpc.calls).toBe(2);
  });

  it('rejects a TTL that is not a non-negative integer', () => {
    expect(() => createHealthCache({ getHealth: async () => HEALTH }, -1)).toThrow(/non-negative/);
    expect(() => createHealthCache({ getHealth: async () => HEALTH }, 1.5)).toThrow(/non-negative/);
  });
});
