// src/content/news/news-seen.ts
// NEWS DESK · B — the dedupe ledger. An item reports ONCE, ever.
//
// Follows the archives-ledger / radar-seen precedent exactly: reuse the shared
// sqlite connection, own a tiny table, lazy init so importing the pure helpers
// is side-effect-free. This is the ONLY ledger the shadow desk writes to (N2).

import type { Statement } from "better-sqlite3";
import { createHash } from "node:crypto";
import { db } from "../../shared/cache.js";

/**
 * Normalized dedupe key for an item URL.
 *
 * Google News redirect stubs carry volatile query strings (?oc=5, tracking
 * params) on an otherwise stable /rss/articles/<opaque-id> path, so the query
 * and fragment are dropped before hashing — the same article fetched twice a
 * day must collapse to one key. Host is lowercased and www-stripped; a trailing
 * slash is normalized away. An unparseable URL falls back to hashing the raw
 * string (never throws — a weird URL still dedupes against itself).
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** SHA-256 of the normalized URL — the PK. PURE. */
export function itemKey(url: string): string {
  return createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 32);
}

let stmts: { has: Statement; insert: Statement } | null = null;

function getStmts() {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_seen (
      item_key   TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL
    );
  `);
  stmts = {
    has: db.prepare(`SELECT 1 FROM news_seen WHERE item_key = ?`),
    insert: db.prepare(`INSERT OR IGNORE INTO news_seen (item_key, first_seen) VALUES (?, ?)`),
  };
  return stmts;
}

/** True if this URL has already been reported (so the desk can skip it). */
export function alreadySeen(url: string): boolean {
  return getStmts().has.get(itemKey(url)) !== undefined;
}

/** Record an item as reported. INSERT OR IGNORE on the PK ⇒ idempotent. */
export function markSeen(url: string, now: number = Date.now()): void {
  getStmts().insert.run(itemKey(url), now);
}

/** Bulk mark — used once, at the end of a successful run. */
export function markAllSeen(urls: string[], now: number = Date.now()): void {
  const { insert } = getStmts();
  const tx = db.transaction((list: string[]) => {
    for (const u of list) insert.run(itemKey(u), now);
  });
  tx(urls);
}
