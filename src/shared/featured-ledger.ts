// src/shared/featured-ledger.ts
// Cross-pillar de-duplication ledger. Records the films actually FEATURED on a
// published card (NOT the whole discovery window) so the same film cannot be
// re-featured by a colliding pillar within COOLDOWN_DAYS. Reuses the shared
// sqlite connection from cache.ts (single connection, WAL).
//
// DEDUP_MODE flips the entire policy with one constant:
//   "per-pair" (default) — Mon Movement + Wed Drop (OTT) share ONE lane (the
//      collision being fixed). Wed Drop (Theatrical) is its own lane. Sat Verdict
//      and Sun Spotlight are independent and MAY re-feature a standout on purpose.
//   "global" — a film featured by ANY pillar is off-limits to EVERY pillar.

import type { Statement } from "better-sqlite3";
import type { Release } from "./types.js";
import { db } from "./cache.js";
import { log } from "./logger.js";

export type PillarKey = "mon" | "wed-ott" | "wed-theatrical" | "sat" | "sun";

export const DEDUP_MODE: "per-pair" | "global" = "per-pair";
export const COOLDOWN_DAYS = 14;

const PER_PAIR_LANES: PillarKey[][] = [
  ["mon", "wed-ott"],
  ["wed-theatrical"],
  ["sat"],
  ["sun"],
];
const ALL_PILLARS: PillarKey[] = ["mon", "wed-ott", "wed-theatrical", "sat", "sun"];

export function laneFor(pillar: PillarKey): PillarKey[] {
  if (DEDUP_MODE === "global") return ALL_PILLARS;
  return PER_PAIR_LANES.find(l => l.includes(pillar)) ?? [pillar];
}

export interface FeaturedRow {
  film_key: string;
  pillar: string;
  issue: string;
  featured_at: number;
  title: string | null;
}

export function filmKey(r: Pick<Release, "imdbId" | "tmdbId" | "title">): string {
  if (r.imdbId) return r.imdbId;
  if (r.tmdbId) return `tmdb:${r.tmdbId}`;
  return `title:${r.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

// PURE: which keys are excluded, given already-fetched rows. Unit-tested.
export function selectExcludedKeys(
  rows: FeaturedRow[],
  opts: { lane: PillarKey[]; cooldownDays: number; now: number; excludeIssue?: string }
): Set<string> {
  const cutoff = opts.now - opts.cooldownDays * 24 * 60 * 60 * 1000;
  const laneSet = new Set<string>(opts.lane);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.featured_at < cutoff) continue;
    if (!laneSet.has(row.pillar)) continue;
    if (opts.excludeIssue && row.issue === opts.excludeIssue) continue;
    out.add(row.film_key);
  }
  return out;
}

// Lazy db init so importing the pure helpers never touches the ledger table.
let stmts: { insert: Statement; deleteIssue: Statement; recentRows: Statement } | null = null;

function getStmts() {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS featured_films (
      film_key    TEXT NOT NULL,
      pillar      TEXT NOT NULL,
      issue       TEXT NOT NULL,
      featured_at INTEGER NOT NULL,
      title       TEXT,
      PRIMARY KEY (film_key, pillar, issue)
    );
    CREATE INDEX IF NOT EXISTS idx_featured_at ON featured_films(featured_at);
  `);
  stmts = {
    insert: db.prepare(
      `INSERT OR REPLACE INTO featured_films (film_key, pillar, issue, featured_at, title)
       VALUES (?, ?, ?, ?, ?)`
    ),
    deleteIssue: db.prepare(`DELETE FROM featured_films WHERE pillar = ? AND issue = ?`),
    recentRows: db.prepare(
      `SELECT film_key, pillar, issue, featured_at, title FROM featured_films WHERE featured_at >= ?`
    ),
  };
  return stmts;
}

// Exclude set for `pillar` right now. excludeIssue lets a same-issue re-run ignore
// its OWN prior featuring, so re-posting an issue is not self-blocking.
export function excludedKeysFor(
  pillar: PillarKey,
  opts: { excludeIssue?: string; now?: number } = {}
): Set<string> {
  const now = opts.now ?? Date.now();
  const cutoff = now - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const rows = getStmts().recentRows.all(cutoff) as FeaturedRow[];
  return selectExcludedKeys(rows, {
    lane: laneFor(pillar),
    cooldownDays: COOLDOWN_DAYS,
    now,
    // Spread only when present: under exactOptionalPropertyTypes, passing an
    // explicit `undefined` to the exact-optional `excludeIssue?` is a type error.
    ...(opts.excludeIssue !== undefined ? { excludeIssue: opts.excludeIssue } : {}),
  });
}

// Record the films actually placed on a published card. Re-running the same issue
// replaces that issue's rows (delete+insert) so a re-post is idempotent.
export function recordFeatured(
  films: Array<Pick<Release, "imdbId" | "tmdbId" | "title">>,
  pillar: PillarKey,
  issue: string,
  now: number = Date.now()
): void {
  const s = getStmts();
  const tx = db.transaction(() => {
    s.deleteIssue.run(pillar, issue);
    for (const f of films) s.insert.run(filmKey(f), pillar, issue, now, f.title);
  });
  tx();
  log.info(`[ledger] recorded ${films.length} featured film(s) — pillar=${pillar} issue=${issue}`);
}
