/**
 * Cached RPC health reads.
 *
 * `indexerHealth` used to call `getHealth` on the RPC for every request, which
 * made the API's own availability depend on the RPC's, and let a slow RPC stall
 * every page. The cache keeps the newest successful value for a short, explicit
 * TTL and reports how old it is, so a stale reading can never be mistaken for a
 * fresh one. Failures are never cached: a failing RPC must surface immediately.
 */

import type { HealthResult, SorobanRpcClient } from './client.js';

export interface CachedHealth extends HealthResult {
  /** ISO-8601 instant the cached RPC response was received. */
  observedAt: string;
  /** `now - observedAt` in milliseconds at read time. */
  ageMs: number;
}

export interface HealthCache {
  get(): Promise<CachedHealth>;
  /** Test seam: the injected clock. */
  clear(): void;
}

export function createHealthCache(
  rpc: Pick<SorobanRpcClient, 'getHealth'>,
  ttlMs: number,
  now: () => number = Date.now,
): HealthCache {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error(`health cache TTL must be a non-negative integer (got ${String(ttlMs)})`);
  }
  let cached: { value: HealthResult; observedAtMs: number } | undefined;
  let inFlight: Promise<CachedHealth> | undefined;

  function present(value: HealthResult, observedAtMs: number): CachedHealth {
    const at = now();
    return { ...value, observedAt: new Date(observedAtMs).toISOString(), ageMs: Math.max(0, at - observedAtMs) };
  }

  return {
    async get(): Promise<CachedHealth> {
      const at = now();
      if (cached !== undefined && at - cached.observedAtMs < ttlMs) {
        return present(cached.value, cached.observedAtMs);
      }
      if (inFlight !== undefined) return inFlight;
      inFlight = (async () => {
        try {
          const value = await rpc.getHealth();
          const observedAtMs = now();
          cached = { value, observedAtMs };
          return present(value, observedAtMs);
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    },
    clear(): void {
      cached = undefined;
      inFlight = undefined;
    },
  };
}
