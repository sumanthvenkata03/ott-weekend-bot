// scripts/movie-lookup/ratelimit.ts
// Pure, in-memory per-IP token-bucket rate limiter for the movie-lookup server's
// /api/* surface. No timers, no network, no SQLite — refills are computed lazily
// from elapsed wall-clock time on each take(), so it's fully deterministic under an
// injected `now` and trivially unit-testable (see ratelimit.check.ts).
//
// Model: each IP owns a bucket of up to `burst` tokens that refills at `perMin`
// tokens per minute, capped at the `burst` ceiling. take() costs one token: it
// returns true (allowed) when a whole token is available, false (limited) otherwise.
//
// Memory is bounded to at most `maxIps` buckets on a long-lived instance: a Map
// preserves insertion order, every touched IP is re-inserted as most-recent, and any
// buckets beyond the cap are evicted least-recently-used first — swept on access, so
// there are no background timers (the same LRU trick cache.ts uses).

export interface LimiterOptions {
  perMin: number; // sustained tokens added per minute
  burst: number; // bucket capacity (max tokens); also the initial fill for a new IP
  maxIps: number; // max distinct IP buckets retained (LRU eviction beyond this)
}

interface Bucket {
  tokens: number; // current whole + fractional token balance
  updated: number; // ms timestamp of the last lazy refill
}

export interface Limiter {
  /** Consume one token for `ip`. Returns true if allowed, false if over the limit. */
  take(ip: string, now?: number): boolean;
  /** Current number of tracked IP buckets (for tests / introspection). */
  size(): number;
}

export function createLimiter(opts: LimiterOptions): Limiter {
  // Clamp the knobs to sane minimums so a misconfigured env can never divide-by-zero
  // or create a zero-capacity bucket that rejects everything.
  const perMin = opts.perMin > 0 ? opts.perMin : 1;
  const burst = opts.burst > 0 ? opts.burst : 1;
  const maxIps = opts.maxIps > 0 ? Math.floor(opts.maxIps) : 1;
  const ratePerMs = perMin / 60000;
  const buckets = new Map<string, Bucket>();

  function take(ip: string, now: number = Date.now()): boolean {
    let b = buckets.get(ip);
    if (!b) {
      // First time we see this IP → a full bucket.
      b = { tokens: burst, updated: now };
    } else {
      // Lazy refill from elapsed time since the last take, capped at the ceiling.
      const elapsed = now - b.updated;
      if (elapsed > 0) {
        b.tokens = Math.min(burst, b.tokens + elapsed * ratePerMs);
        b.updated = now;
      }
      buckets.delete(ip); // LRU touch: re-inserted below as most-recently-used
    }

    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    buckets.set(ip, b);

    // Evict least-recently-used buckets beyond the cap (sweep on access; no timers).
    while (buckets.size > maxIps) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
    return allowed;
  }

  return { take, size: () => buckets.size };
}
