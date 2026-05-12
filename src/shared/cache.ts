// src/shared/cache.ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";

const DB_PATH = "data/cache.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS http_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_http_cache_expires ON http_cache(expires_at);
`);

const getStmt = db.prepare("SELECT value, expires_at FROM http_cache WHERE key = ?");
const setStmt = db.prepare(
  "INSERT OR REPLACE INTO http_cache (key, value, expires_at) VALUES (?, ?, ?)"
);
const purgeStmt = db.prepare("DELETE FROM http_cache WHERE expires_at < ?");

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
  const now = Date.now();
  const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
  
  if (row && row.expires_at > now) {
    return JSON.parse(row.value) as T;
  }
  
  const fresh = await loader();
  setStmt.run(key, JSON.stringify(fresh), now + opts.ttlSeconds * 1000);
  return fresh;
}

/**
 * Drop expired entries. Call once at process start.
 */
export function purgeExpired(): void {
  const result = purgeStmt.run(Date.now());
  if (result.changes > 0) {
    log.info(`Cache: purged ${result.changes} expired entries`);
  }
}

export function cacheStats(): { total: number; expired: number } {
  const total = (db.prepare("SELECT COUNT(*) as c FROM http_cache").get() as { c: number }).c;
  const expired = (db.prepare("SELECT COUNT(*) as c FROM http_cache WHERE expires_at < ?")
    .get(Date.now()) as { c: number }).c;
  return { total, expired };
}