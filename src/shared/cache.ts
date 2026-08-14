// src/shared/cache.ts
//
// ── WD-ENG-10C: THE DB OPENS ON FIRST USE, NOT ON IMPORT ────────────────────
// This module used to open data/cache.sqlite and issue three writes — the WAL
// pragma, a CREATE TABLE and a CREATE INDEX — at MODULE LOAD. 39 modules import
// it, so every vitest worker that touched any of them opened and wrote to the
// SAME sqlite file at the same moment. Under the default parallel pool that
// contention intermittently returned SQLITE_IOERR ("disk I/O error") while a
// test file was being COLLECTED, and the victim file then contributed 0 of its
// cases to the run — a different file each time, which is why the suite total
// wandered (1290, 1249, 1228 against 1306).
//
// Almost none of those 39 importers ever read or write the cache: they import a
// helper that happens to live downstream of a `cached()` call they do not make.
// Deferring the open to the first ACTUAL use removes the whole class of
// contention without changing what a real caller sees.
//
// ── THE CONTRACT THIS PRESERVES ─────────────────────────────────────────────
// Once initialized, behaviour is byte-identical to the eager version: same file,
// same pragma, same DDL, same three prepared statements, same order. The only
// observable change is WHEN that happens — and, consequently, that a broken or
// unwritable data/ directory now surfaces at the first cache call instead of at
// import. That is the intended trade: an import must not be able to fail, and
// must not be able to contend.
//
// ── WHY A PLAIN `if (handles)` IS A SUFFICIENT ONCE-GUARD ───────────────────
// `init()` is entirely synchronous — no `await`, no I/O callback, nothing that
// yields. Node cannot interleave another caller inside it, so the check-then-set
// is atomic by construction and a second caller (concurrent or not) always sees
// the finished handles. This is deliberate, not incidental: keep init sync. If a
// future change needs async setup, it needs a promise-memo instead, and the
// double-init pin in cache-lazy-init.test.ts is what will tell you.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

const DB_PATH = "data/cache.sqlite";

interface CacheHandles {
  db: Database.Database;
  get: Database.Statement;
  set: Database.Statement;
  purge: Database.Statement;
}

let handles: CacheHandles | null = null;

/** Open + migrate + prepare, exactly once. Synchronous — see the header note. */
function init(): CacheHandles {
  if (handles) return handles;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS http_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_http_cache_expires ON http_cache(expires_at);
  `);

  // Assigned in ONE statement after every fallible step has succeeded: a throw
  // anywhere above leaves `handles` null, so the next caller retries a clean
  // init rather than inheriting a half-built one.
  handles = {
    db: conn,
    get: conn.prepare("SELECT value, expires_at FROM http_cache WHERE key = ?"),
    set: conn.prepare(
      "INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)"
    ),
    purge: conn.prepare("DELETE FROM http_cache WHERE expires_at < ?"),
  };
  return handles;
}

type Indexable = Record<PropertyKey, unknown>;

/**
 * The shared connection. Six modules own their own tables on it
 * (archives-ledger, news-seen, radar-seen, research/http, research/consolidate,
 * scripts/archives-reset) and reach it through this binding.
 *
 * It is a Proxy so that `import { db }` stays a zero-cost import while
 * `db.anything` still behaves exactly like the real Database: the first property
 * touch — `.prepare`, `.exec`, `.transaction`, `.backup`, `.name` — runs init()
 * and forwards. Methods are bound to the real connection because better-sqlite3
 * is a native binding and would reject the proxy as its `this`.
 *
 * Keeping the export shaped as a value (rather than a `getDb()` function) is
 * what makes this change invisible to callers: not one call site moves.
 */
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, prop) {
    const conn = init().db as unknown as Indexable;
    const value = conn[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(conn)
      : value;
  },
  set(_target, prop, value) {
    (init().db as unknown as Indexable)[prop] = value;
    return true;
  },
  has(_target, prop) {
    return prop in (init().db as unknown as object);
  },
  getPrototypeOf() {
    return Object.getPrototypeOf(init().db) as object;
  },
});

export interface CacheOptions {
  /** Time-to-live in seconds */
  ttlSeconds: number;
}

/**
 * Cache wrapper. Returns cached value if fresh, otherwise calls loader and caches result.
 */
export async function cached<T>(
  key: string,
  loader: () => Promise<T>,
  opts: CacheOptions
): Promise<T> {
  const h = init();
  const now = Date.now();
  const row = h.get.get(key) as { value: string; expires_at: number } | undefined;

  if (row && row.expires_at > now) {
    return JSON.parse(row.value) as T;
  }

  const fresh = await loader();
  h.set.run(key, JSON.stringify(fresh), now + opts.ttlSeconds * 1000);
  return fresh;
}

/**
 * Drop expired entries. Call once at process start.
 */
export function purgeExpired(): void {
  const result = init().purge.run(Date.now());
  if (result.changes > 0) {
    log.info(`Cache: purged ${result.changes} expired entries`);
  }
}

export function cacheStats(): { total: number; expired: number } {
  const conn = init().db;
  const total = (conn.prepare("SELECT COUNT(*) as c FROM http_cache").get() as { c: number }).c;
  const expired = (conn.prepare("SELECT COUNT(*) as c FROM http_cache WHERE expires_at < ?")
    .get(Date.now()) as { c: number }).c;
  return { total, expired };
}

/**
 * TEST SEAM ONLY. Reports whether the connection has been opened yet. Exported
 * so the lazy-init pin can assert "importing this module opened nothing" without
 * reaching into module internals or touching `db` (which would itself init).
 */
export function isInitializedForTests(): boolean {
  return handles !== null;
}
