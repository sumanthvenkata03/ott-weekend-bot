// src/content/archives/archives-ledger.ts
// TBSI Archives PERMANENT no-repeat ledger + own VOL counter.
//
// Distinct from the cross-pillar featured-ledger (which is a 14-day COOLDOWN
// window, lane-scoped): Archives promises a film is NEVER re-featured, ever. A
// cooldown lane cannot express "forever" (its exclusion filters featured_at >=
// cutoff at the SQL layer), and the PillarKey union has no "archives" member —
// so Archives owns its own tiny table rather than bending featured-ledger.ts.
// We reuse the shared sqlite connection (db) and the PURE, exported filmKey()
// from featured-ledger so key derivation stays byte-identical across pillars.
//
// The table also carries `kind` ('pick' | 'treasure') — cheap to add now,
// costly to migrate later — so a monthly treasure edition is queryable without
// a schema change.

import type { Statement } from "better-sqlite3";
import type { Release } from "../../shared/types.js";
import { db } from "../../shared/cache.js";
import { filmKey } from "../../shared/featured-ledger.js";
import { log } from "../../shared/logger.js";

export type ArchivesKind = "pick" | "treasure";

export interface ArchivesRow {
  film_key: string;
  tmdb_id: number | null;
  title: string | null;
  vol: number;
  kind: string;
  featured_at: number;
}

/** A film about to be recorded, tagged with which slot it filled. */
export interface ArchivesPick {
  film: Pick<Release, "imdbId" | "tmdbId" | "title">;
  kind: ArchivesKind;
}

// ── PURE helpers (unit-tested; never touch the db) ───────────────────────────

/** The exclusion set for a PERMANENT ledger is simply every key ever recorded. */
export function keysOf(rows: Pick<ArchivesRow, "film_key">[]): Set<string> {
  return new Set(rows.map((r) => r.film_key));
}

/** Next volume from the current max (null/none → 001). Volume is 1-indexed. */
export function nextVolumeFrom(maxVol: number | null | undefined): number {
  return (maxVol ?? 0) + 1;
}

/** Zero-padded "NNN" display form of a volume number (VOL. 001). */
export function formatVolume(vol: number): string {
  return String(vol).padStart(3, "0");
}

// ── db-backed API (lazy init so importing the pure helpers is side-effect-free) ──

let stmts: {
  insert: Statement;
  allKeys: Statement;
  maxVol: Statement;
} | null = null;

function getStmts() {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS archives_featured (
      film_key    TEXT PRIMARY KEY,
      tmdb_id     INTEGER,
      title       TEXT,
      vol         INTEGER NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'pick',
      featured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archives_vol ON archives_featured(vol);
  `);
  stmts = {
    insert: db.prepare(
      `INSERT OR IGNORE INTO archives_featured (film_key, tmdb_id, title, vol, kind, featured_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    allKeys: db.prepare(`SELECT film_key FROM archives_featured`),
    maxVol: db.prepare(`SELECT MAX(vol) AS m FROM archives_featured`),
  };
  return stmts;
}

/** Every film_key ever featured by Archives — the PERMANENT exclusion set. */
export function excludedArchivesKeys(): Set<string> {
  const rows = getStmts().allKeys.all() as Pick<ArchivesRow, "film_key">[];
  return keysOf(rows);
}

/**
 * The volume number the NEXT edition will carry. Computed from the ledger's max
 * so it is deterministic and needs no stored counter. Read BEFORE selection (it
 * drives the language-rotation window); recording happens only after a
 * successful render + deliver (see friday-archives.ts).
 */
export function nextVolume(): number {
  const row = getStmts().maxVol.get() as { m: number | null };
  return nextVolumeFrom(row.m);
}

/**
 * Record the films actually placed on a published Archives deck. INSERT OR
 * IGNORE on the film_key PK: a film can never be recorded twice, so a re-run
 * that somehow re-selected a prior pick is a no-op rather than a bump. Called
 * ONLY after render + deliver succeed, so a failed run burns no picks.
 */
export function recordArchivesPicks(
  picks: ArchivesPick[],
  vol: number,
  now: number = Date.now()
): void {
  const s = getStmts();
  const tx = db.transaction(() => {
    for (const p of picks) {
      s.insert.run(filmKey(p.film), p.film.tmdbId ?? null, p.film.title, vol, p.kind, now);
    }
  });
  tx();
  log.info(
    `[archives-ledger] recorded ${picks.length} film(s) — VOL. ${formatVolume(vol)} ` +
      `(${picks.filter((p) => p.kind === "treasure").length} treasure)`
  );
}
