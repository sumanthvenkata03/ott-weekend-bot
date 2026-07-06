// scripts/movie-lookup/cache.ts
// In-memory TTL + LRU response cache for the movie-lookup server. This is the
// TOOL's own cache — completely separate from the pipeline's cache.sqlite, which
// is never touched. It exists only to make repeat/similar lookups instant within
// a short window; live API calls still happen on a miss.
//
// Bounded by max entries (LRU eviction of the least-recently-used key) so memory
// can't grow unbounded on a long-lived Render instance. TTL is configurable via
// MOVIE_LOOKUP_CACHE_TTL_MS (see server.ts).
//
// `now` is injectable on every method purely so tests can exercise TTL expiry
// deterministically without waiting on the wall clock.

export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

interface Entry {
  value: unknown;
  expires: number;
}

export const DEFAULT_TTL_MS = 20 * 60 * 1000; // 20 minutes
export const DEFAULT_MAX_ENTRIES = 500;

export class TtlCache {
  // A Map preserves insertion order, which we use as the LRU order: the first
  // key is the least-recently-used, the last is the most-recently-used.
  private readonly map = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  }

  /** Live (non-expired) entry, refreshed to most-recently-used. Undefined if absent/expired. */
  private lookup(key: string, now: number): Entry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.map.delete(key); // lazy expiry
      return undefined;
    }
    // LRU touch: delete + re-set moves the key to the newest position.
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }

  has(key: string, now: number = Date.now()): boolean {
    return this.lookup(key, now) !== undefined;
  }

  get(key: string, now: number = Date.now()): unknown | undefined {
    const e = this.lookup(key, now);
    if (e) {
      this.hits++;
      return e.value;
    }
    this.misses++;
    return undefined;
  }

  set(key: string, value: unknown, now: number = Date.now()): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: now + this.ttlMs });
    // Evict least-recently-used until within the bound.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /**
   * Cache-aside wrapper: returns the cached value on a live hit; otherwise runs
   * `loader()`, stores its result, and returns it. A rejected loader is NOT
   * cached (the error propagates and the next call retries).
   */
  async wrap<T>(key: string, loader: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const e = this.lookup(key, now);
    if (e) {
      this.hits++;
      return e.value as T;
    }
    this.misses++;
    const value = await loader();
    this.set(key, value, now);
    return value;
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.map.size;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }
}
