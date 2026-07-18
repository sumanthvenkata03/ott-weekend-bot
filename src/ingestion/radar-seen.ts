// src/ingestion/radar-seen.ts
// Dedupe ledger for the Reddit thread radar: a thread pings ONCE ever. Its own
// tiny table in the shared sqlite db (the archives-ledger precedent — reuse the
// shared connection, own the table; featured-ledger is untouched). Lazy init so
// importing the pure helpers stays side-effect-free.

import type { Statement } from "better-sqlite3";
import { db } from "../shared/cache.js";

let stmts: { has: Statement; insert: Statement } | null = null;

function getStmts() {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_seen (
      post_id  TEXT PRIMARY KEY,
      seen_at  INTEGER NOT NULL
    );
  `);
  stmts = {
    has: db.prepare(`SELECT 1 FROM radar_seen WHERE post_id = ?`),
    insert: db.prepare(`INSERT OR IGNORE INTO radar_seen (post_id, seen_at) VALUES (?, ?)`),
  };
  return stmts;
}

/** True if this post has already pinged (so the radar can skip it). */
export function alreadySeen(postId: string): boolean {
  return getStmts().has.get(postId) !== undefined;
}

/** Record that a post pinged. INSERT OR IGNORE on the PK ⇒ idempotent. */
export function markSeen(postId: string, now: number = Date.now()): void {
  getStmts().insert.run(postId, now);
}
