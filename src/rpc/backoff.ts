/**
 * Bounded exponential backoff with full jitter (I2).
 *
 * Policy (published here so tests pin it):
 * - attempt n (0-based) waits `random() * min(capMs, baseMs * 2^n)` — full
 *   jitter, never longer than capMs, never negative;
 * - at most `retries` retries (`retries + 1` attempts total) — bounded: after
 *   the budget is spent the last error is rethrown loud;
 * - only `RetryableError`s are retried; anything else propagates immediately
 *   (fail closed — a malformed request must not be retried into a false sense
 *   of health).
 */

export class RetryableError extends Error {
  override readonly name = 'RetryableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface BackoffOptions {
  /** Number of retries after the first attempt (default 5). */
  retries: number;
  /** First-attempt ceiling in ms (default 500). */
  baseMs: number;
  /** Hard ceiling for any single delay in ms (default 30_000). */
  capMs: number;
  /** Random source in [0,1); injectable for tests (default Math.random). */
  random: () => number;
  /** Sleeper; injectable for tests (default setTimeout). */
  sleep: (ms: number) => Promise<void>;
  /** Observability hook: fired with the delay before sleeping (tests). */
  onDelay?: (ms: number, attempt: number) => void;
}

export type BackoffInput = Partial<BackoffOptions>;

export const DEFAULT_BACKOFF: Readonly<Omit<BackoffOptions, 'random' | 'sleep'>> = {
  retries: 5,
  baseMs: 500,
  capMs: 30_000,
};

/** Delay for attempt `attempt` (0-based): full jitter, bounded by capMs. */
export function computeDelayMs(attempt: number, opts: Pick<BackoffOptions, 'baseMs' | 'capMs' | 'random'>): number {
  if (attempt < 0 || !Number.isFinite(attempt)) {
    throw new Error(`backoff attempt must be a non-negative finite number (got ${attempt})`);
  }
  const ceiling = Math.min(opts.capMs, opts.baseMs * 2 ** attempt);
  const delay = opts.random() * ceiling;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new Error(`backoff produced an invalid delay: ${delay}`);
  }
  return Math.min(delay, opts.capMs);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn`; retry only RetryableErrors with bounded exponential backoff +
 * jitter. Non-retryable errors and the exhausted budget rethrow the original
 * error (with attempt count attached for context).
 */
export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  input: BackoffInput = {},
): Promise<T> {
  const opts: BackoffOptions = {
    retries: input.retries ?? DEFAULT_BACKOFF.retries,
    baseMs: input.baseMs ?? DEFAULT_BACKOFF.baseMs,
    capMs: input.capMs ?? DEFAULT_BACKOFF.capMs,
    random: input.random ?? Math.random,
    sleep: input.sleep ?? defaultSleep,
    ...(input.onDelay !== undefined ? { onDelay: input.onDelay } : {}),
  };
  if (opts.retries < 0) throw new Error(`retries must be >= 0 (got ${opts.retries})`);

  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof RetryableError;
      const budgetLeft = attempt < opts.retries;
      if (!retryable || !budgetLeft) {
        if (retryable) {
          // Budget exhausted on a retryable error: loud, with context.
          throw new RetryableError(
            `giving up after ${attempt + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        }
        throw err;
      }
      const delay = computeDelayMs(attempt, opts);
      opts.onDelay?.(delay, attempt);
      await opts.sleep(delay);
    }
  }
  /* c8 ignore next -- loop always returns or throws */
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
