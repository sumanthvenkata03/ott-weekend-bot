// src/discovery/radar-pool.ts
// WD-ENG-22C — THE RADAR POOL. A quarantined holding pen for DATELESS finds.
//
// ── WHAT IT IS ──────────────────────────────────────────────────────────────
// WD-ENG-17 PART 3 made the news net refuse to emit a candidate from an undated
// headline: "no date -> no candidate. Never a dated candidate from an undated
// headline." That guard is correct and it stays byte-intact. But the discarded
// finds are not worthless — "Film X is heading to SonyLIV" is a real, sourced
// observation. It is simply not a RELEASE, and it must never be treated as one.
//
// So the drop site now also drops a copy HERE, where nothing that decides what
// gets published can see it.
//
// ── THE QUARANTINE, STATED PLAINLY ──────────────────────────────────────────
// EXACTLY ONE reader exists: the posting-kit generator, which turns these into
// "X is <platform>-bound, no official date yet" lines for the Instagram FIRST
// COMMENT. Reconcile, discovery selection, tiering, the gate and the deck must
// NEVER read this table. A row here has:
//
//   - NO date, and none is ever stored. There is nothing to leak into a
//     landing-window check even by accident.
//   - NO tmdbId, NO resolution, NO country gate. These finds never went through
//     any of it.
//
// A test greps the import graph: only posting-kit may import the read function.
// If that ever stops being true, the WD-ENG-17 guard has been reopened through
// the back door.
//
// Mirrors radar-seen.ts's store pattern (shared sqlite connection from cache.ts,
// its own table, lazy getStmts). MIRRORS rather than REUSES: radar_seen answers
// "has this Reddit thread already pinged?" and is keyed on a post id. Different
// question, different key, different lifetime — sharing the table would conflate
// two ledgers that happen to share a prefix in their names.

import type { Statement } from "better-sqlite3";
import { db } from "../shared/cache.js";
import { log } from "../shared/logger.js";

/** Rows older than this (measured from lastSeen) stop being reported. */
export const RADAR_POOL_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RadarPoolRow {
  /** Normalized dedupe key derived from the title. */
  key: string;
  /** The title as the headline gave it (display form). */
  title: string;
  /** The platform a source named, when one did. NEVER a date. */
  platform: string | null;
  source_url: string;
  first_seen: number;
  last_seen: number;
}

/**
 * Dedupe key. Lowercase, strip everything non-alphanumeric to single hyphens.
 * Deliberately cruder than discovery's normalizeTitle: this pool feeds a
 * first-comment line, not a match, so over-merging two similar titles costs a
 * duplicate line at worst — while under-merging would let one film accumulate a
 * row per headline spelling and flood the comment.
 */
export function radarKey(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

let stmts: { upsert: Statement; touch: Statement; fresh: Statement; purge: Statement; clear: Statement } | null = null;

function getStmts() {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS radar_pool (
      key         TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      platform    TEXT,
      source_url  TEXT NOT NULL,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_radar_pool_last_seen ON radar_pool(last_seen);
  `);
  stmts = {
    // INSERT OR IGNORE + a separate UPDATE, rather than INSERT OR REPLACE: a
    // replace would reset first_seen, and "we have been hearing about this film
    // since June" is the one thing the pool knows that a single headline does not.
    upsert: db.prepare(
      `INSERT OR IGNORE INTO radar_pool (key, title, platform, source_url, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    touch: db.prepare(
      `UPDATE radar_pool
          SET last_seen = ?,
              title      = ?,
              source_url = ?,
              -- Keep a known platform if the newer sighting has none: a later
              -- headline that omits the platform is not a retraction.
              platform   = COALESCE(?, platform)
        WHERE key = ?`
    ),
    fresh: db.prepare(`SELECT * FROM radar_pool WHERE last_seen >= ? ORDER BY last_seen DESC, key ASC`),
    purge: db.prepare(`DELETE FROM radar_pool WHERE last_seen < ?`),
    clear: db.prepare(`DELETE FROM radar_pool`),
  };
  return stmts;
}

/**
 * Record one dateless find. Called from the news net's drop site ONLY.
 *
 * NEVER THROWS. A radar-pool failure must not be able to take down discovery —
 * this is a side-channel for a first-comment nicety, and the guard it sits
 * beside is load-bearing. Returns true if a row was written or touched.
 */
export function recordRadarFind(find: {
  title: string;
  platform?: string | undefined;
  sourceUrl?: string | undefined;
  now?: number;
}): boolean {
  const key = radarKey(find.title);
  if (!key) return false;                    // degenerate title — nothing to key on
  const url = find.sourceUrl?.trim();
  if (!url) return false;                    // no cite, no line: the pool is sourced or it is nothing
  const platform = find.platform?.trim() || null;
  const now = find.now ?? Date.now();
  try {
    const s = getStmts();
    s.upsert.run(key, find.title, platform, url, now, now);
    s.touch.run(now, find.title, url, platform, key);
    return true;
  } catch (err) {
    log.warn(`  radar pool: could not record "${find.title}"`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * THE ONLY READ. Fresh rows (lastSeen within RADAR_POOL_TTL_DAYS), newest first.
 *
 * Expiry is applied on READ as well as by the purge below, so a pool that has
 * not been purged in months still cannot report a year-old rumour.
 */
export function readRadarPool(now: number = Date.now()): RadarPoolRow[] {
  try {
    return getStmts().fresh.all(now - RADAR_POOL_TTL_DAYS * DAY_MS) as RadarPoolRow[];
  } catch (err) {
    log.warn("  radar pool: read failed — reporting none", err instanceof Error ? err.message : err);
    return [];
  }
}

/** Drop rows past their TTL. Best-effort housekeeping; never throws. */
export function purgeRadarPool(now: number = Date.now()): number {
  try {
    return getStmts().purge.run(now - RADAR_POOL_TTL_DAYS * DAY_MS).changes;
  } catch {
    return 0;
  }
}

/** TEST SEAM ONLY — see verdict-ledger.ts's clearVerdictLedgerForTests. */
export function clearRadarPoolForTests(): void {
  getStmts().clear.run();
}
