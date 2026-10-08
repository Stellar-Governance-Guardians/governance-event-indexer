import { describe, expect, it } from 'vitest';
import {
  computeDelayMs,
  withBackoff,
  RetryableError,
  DEFAULT_BACKOFF,
} from '../../src/rpc/backoff.js';

describe('computeDelayMs', () => {
  const ceiling = (attempt: number) =>
    Math.min(DEFAULT_BACKOFF.capMs, DEFAULT_BACKOFF.baseMs * 2 ** attempt);

  it('stays within [0, ceiling] and never exceeds capMs (full jitter)', () => {
    for (const attempt of [0, 1, 2, 3, 10, 30]) {
      for (const r of [0, 0.25, 0.5, 0.999999, 1]) {
        const delay = computeDelayMs(attempt, {
          baseMs: DEFAULT_BACKOFF.baseMs,
          capMs: DEFAULT_BACKOFF.capMs,
          random: () => r,
        });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(Math.min(DEFAULT_BACKOFF.capMs, ceiling(attempt)));
        expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.capMs);
      }
    }
  });

  it('grows exponentially with the attempt, capped at capMs', () => {
    const at = (attempt: number) =>
      computeDelayMs(attempt, { baseMs: 500, capMs: 30_000, random: () => 1 });
    expect(at(0)).toBe(500);
    expect(at(1)).toBe(1000);
    expect(at(2)).toBe(2000);
    expect(at(20)).toBe(30_000); // capped, not 500 * 2^20
  });

  it('rejects invalid attempts or random sources (fail loud)', () => {
    expect(() =>
      computeDelayMs(-1, { baseMs: 500, capMs: 1000, random: () => 0.5 }),
    ).toThrow(/non-negative/);
    expect(() =>
      computeDelayMs(0, { baseMs: 500, capMs: 1000, random: () => -3 }),
    ).toThrow(/invalid delay/);
  });
});

describe('withBackoff', () => {
  const instant = { retries: 3, baseMs: 1, capMs: 4, random: () => 0.5, sleep: async () => {} };

  it('retries RetryableErrors with bounded delays, then succeeds', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError('transient');
        return 'ok';
      },
      { ...instant, onDelay: (ms) => delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(instant.capMs);
    }
  });

  it('gives up after the bounded budget and reports the attempts', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new RetryableError('always down');
        },
        instant,
      ),
    ).rejects.toThrow(/giving up after 4 attempts/);
    expect(calls).toBe(4); // retries + 1, no more
  });

  it('never retries a non-retryable error', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw new Error('fatal: bad request');
        },
        instant,
      ),
    ).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });

  it('returns immediately on success without sleeping', async () => {
    let n = 0;
    const out = await withBackoff(async () => {
      n += 1;
      return 42;
    }, { ...instant, sleep: async () => { throw new Error('must not sleep'); } });
    expect(out).toBe(42);
    expect(n).toBe(1);
  });
});
