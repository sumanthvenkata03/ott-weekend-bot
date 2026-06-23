// src/research/http.ts
// Thin cached-fetch helper for research sources. Mirrors the
// tmdbFetchCached / pThrottle style in src/ingestion/releases/tmdb.ts, but
// reuses the EXISTING shared http_cache table (src/shared/cache.ts) — no
// second cache store — and additionally reports whether the value came from
// cache (cached:true) or a live request (cached:false). That flag lets
// quota-limited sources (e.g. YouTube, later) tell live vs cached calls apart.
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { db } from "../shared/cache.js";

type ResponseType = "json" | "text";
type HttpMethod = "GET" | "POST";

// Direct peek/write against the shared table (same key/value/expires_at schema
// as cache.ts). We go direct because the shared cached() helper does not expose
// a hit/miss flag.
const peekStmt = db.prepare("SELECT value, expires_at FROM http_cache WHERE key = ?");
const putStmt = db.prepare(
  "INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)"
);

// Same throttle profile as tmdb.ts: 4 requests / second across all sources.
const throttle = pThrottle({ limit: 4, interval: 1000 });

interface RawFetchInit {
  responseType: ResponseType;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
}

const rawFetch = throttle(
  (url: string, init: RawFetchInit): Promise<unknown> =>
    ofetch(url, {
      retry: 2,
      retryDelay: 500,
      responseType: init.responseType,
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
    })
);

export interface CachedFetch<T> {
  value: T;
  cached: boolean;
}

export interface FetchCachedOptions {
  /** Time-to-live in seconds. */
  ttlSeconds: number;
  /** Use "text" for XML/RSS payloads; defaults to "json". */
  responseType?: ResponseType;
  /** HTTP method; defaults to GET. Set "POST" for endpoints like Tavily /search. */
  method?: HttpMethod;
  /** Extra request headers, e.g. { Authorization: `Bearer ${key}` }. */
  headers?: Record<string, string>;
  /** JSON request body for POST; ofetch serializes objects and sets Content-Type. */
  body?: unknown;
}

/**
 * Fetch `url`, caching the raw payload under `key`. Returns { value, cached }
 * where `cached` is true on a fresh cache hit. A thrown loader error
 * propagates and is NOT written to cache — so failures degrade gracefully and
 * never poison the cache.
 */
export async function fetchCached<T = unknown>(
  key: string,
  url: string,
  opts: FetchCachedOptions
): Promise<CachedFetch<T>> {
  const now = Date.now();
  const row = peekStmt.get(key) as { value: string; expires_at: number } | undefined;
  if (row && row.expires_at > now) {
    return { value: JSON.parse(row.value) as T, cached: true };
  }
  const value = (await rawFetch(url, {
    responseType: opts.responseType ?? "json",
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  })) as T;
  putStmt.run(key, JSON.stringify(value), now + opts.ttlSeconds * 1000);
  return { value, cached: false };
}
