// src/content/archives/archives-select.ts
// TBSI Archives selection core — PURE, unit-tested. No I/O, no db, no network.
//
// The REAL quality gate (ruling R3) lives here, NOT in the discover net:
//   imdbRating ≥ 7.3  AND  imdbVotes ≥ 2000  AND  ≥1 streaming platform.
// imdbVotes is REQUIRED — the printed count is the honesty device, so a film
// with no IMDb vote count can never be sealed and can never ship. Hidden-gem
// preference: imdbVotes ≤ 60000 ranks ABOVE famous titles; famous fills gaps.
//
// Every film in a deck must have a DIFFERENT primary genre. Languages come from
// a deterministic window that rotates by volume number over the 7 active
// languages (Bengali is discovered nowhere else and stays out of the rotation).

import type { Release, Language } from "../../shared/types.js";
import { editorialDateUTC, utcStamp } from "../../shared/editorial-clock.js";
import type { ArchivesKind } from "./archives-ledger.js";

// ── Tunable bars ─────────────────────────────────────────────────────────────
export const GATE_MIN_RATING = 7.3;
export const GATE_MIN_VOTES = 2000;
export const GEM_MAX_VOTES = 60000;
export const DEFAULT_MIN_AGE_YEARS = 2;
export const ARCHIVES_TARGET_MIN = 3;
export const ARCHIVES_TARGET_MAX = 4;
export const ROTATION_WINDOW = 3;

/** The 7 active Archives languages (Bengali excluded — no longer covered). */
export const ARCHIVES_LANGUAGES: Language[] = [
  "Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi",
];

// ── Env-dial parsing (pure) ──────────────────────────────────────────────────

/** ARCHIVE_MIN_AGE_YEARS override (default 2). Non-numeric → default. */
export function minAgeYears(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_AGE_YEARS;
}

/** The latest primary_release_date an Archives film may carry: IST-today − years. */
export function archivesCutoffDate(now: Date, years: number): string {
  const anchor = editorialDateUTC(now);
  const cut = new Date(anchor);
  cut.setUTCFullYear(anchor.getUTCFullYear() - years);
  return utcStamp(cut);
}

/** ARCHIVES_LANGS="Telugu|Tamil" override → validated Language[]; else []. */
export function parseLangOverride(raw: string | undefined): Language[] {
  const valid = new Set<Language>(ARCHIVES_LANGUAGES);
  return (raw ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter((s): s is Language => valid.has(s as Language));
}

/** ARCHIVES_PICKS="123,456" → tmdbId[] (curated full-override edition); else []. */
export function parsePickOverride(raw: string | undefined): number[] {
  return (raw ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** ARCHIVES_TREASURE="123" → tmdbId | undefined. */
export function parseTreasure(raw: string | undefined): number | undefined {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The rotating language window for a volume. A window of `count` slides by
 * `count` each volume so consecutive editions don't repeat languages and the
 * whole set is covered over time. Deterministic in `vol`. An override list is
 * returned verbatim (capped at `count`).
 */
export function rotateLanguages(
  vol: number,
  count: number = ROTATION_WINDOW,
  langs: Language[] = ARCHIVES_LANGUAGES,
  override: Language[] = []
): Language[] {
  if (override.length > 0) return override.slice(0, Math.max(count, override.length));
  const n = langs.length;
  const start = ((vol - 1) * count % n + n) % n;
  const out: Language[] = [];
  for (let i = 0; i < Math.min(count, n); i++) out.push(langs[(start + i) % n]!);
  return out;
}

// ── The gate (pure) ──────────────────────────────────────────────────────────

export interface GateResult {
  pass: boolean;
  imdbRating?: number;
  imdbVotes?: number;
  hasPlatform: boolean;
  reasons: string[];
}

/** Evaluate the REAL IMDb-sealed gate for one enriched release. */
export function evaluateGate(r: Release): GateResult {
  const reasons: string[] = [];
  const rating = r.imdbRating;
  const votes = r.imdbVotes;
  const hasPlatform = r.platform.length > 0;
  if (typeof rating !== "number" || rating < GATE_MIN_RATING) {
    reasons.push(`rating ${rating ?? "—"} < ${GATE_MIN_RATING}`);
  }
  if (typeof votes !== "number" || votes < GATE_MIN_VOTES) {
    reasons.push(`votes ${votes ?? "—"} < ${GATE_MIN_VOTES}`);
  }
  if (!hasPlatform) reasons.push("no streaming platform");
  const pass = reasons.length === 0;
  return {
    pass,
    ...(typeof rating === "number" ? { imdbRating: rating } : {}),
    ...(typeof votes === "number" ? { imdbVotes: votes } : {}),
    hasPlatform,
    reasons,
  };
}

/** Gem = a settled-but-not-famous rating window (≤ GEM_MAX_VOTES IMDb votes). */
export function isGem(r: Release): boolean {
  return typeof r.imdbVotes === "number" && r.imdbVotes <= GEM_MAX_VOTES;
}

/** Primary genre = the first listed genre (undefined if none). */
export function primaryGenre(r: Release): string | undefined {
  return r.genre[0];
}

// ── Selection ────────────────────────────────────────────────────────────────

export interface SelectedArchive {
  release: Release;
  kind: ArchivesKind;
  tier: "gem" | "famous";
  primaryGenre?: string;
  imdbRating?: number;
  imdbVotes?: number;
}

export interface SelectionResult {
  picks: SelectedArchive[];
  /** Films evaluated but not carded, with a machine-readable reason. */
  rejected: Array<{ title: string; reason: string }>;
}

export interface SelectOptions {
  excludedKeys: Set<string>;
  filmKey: (r: Pick<Release, "imdbId" | "tmdbId" | "title">) => string;
  min?: number;
  max?: number;
}

/** Shared eligibility: gate + not ledger-excluded. Returns a rejection reason
 *  string when ineligible, or null when the film may card. */
export function ineligibilityReason(
  r: Release,
  excludedKeys: Set<string>,
  filmKey: SelectOptions["filmKey"]
): string | null {
  if (excludedKeys.has(filmKey(r))) return "already featured (permanent no-repeat)";
  const gate = evaluateGate(r);
  if (!gate.pass) return gate.reasons.join("; ");
  return null;
}

export function toSelected(r: Release, kind: ArchivesKind): SelectedArchive {
  const pg = primaryGenre(r);
  return {
    release: r,
    kind,
    tier: isGem(r) ? "gem" : "famous",
    ...(pg ? { primaryGenre: pg } : {}),
    ...(typeof r.imdbRating === "number" ? { imdbRating: r.imdbRating } : {}),
    ...(typeof r.imdbVotes === "number" ? { imdbVotes: r.imdbVotes } : {}),
  };
}

/** Rank: gems before famous; within a tier, higher rating first, then more votes. */
function rank(a: Release, b: Release): number {
  const ga = isGem(a) ? 0 : 1;
  const gb = isGem(b) ? 0 : 1;
  if (ga !== gb) return ga - gb;
  const ra = a.imdbRating ?? 0;
  const rb = b.imdbRating ?? 0;
  if (rb !== ra) return rb - ra;
  return (b.imdbVotes ?? 0) - (a.imdbVotes ?? 0);
}

/**
 * Standard selection: from enriched candidates, keep the eligible ones, rank
 * (gem-first), then greedily pick up to `max` films with PAIRWISE-DISTINCT
 * primary genres. Films that fail the gate, repeat the ledger, or collide on a
 * genre already taken are recorded in `rejected` with a reason.
 */
export function selectArchives(candidates: Release[], opts: SelectOptions): SelectionResult {
  const max = opts.max ?? ARCHIVES_TARGET_MAX;
  const rejected: SelectionResult["rejected"] = [];

  // Dedupe by film key (a film should appear once) and screen eligibility.
  const seenKey = new Set<string>();
  const eligible: Release[] = [];
  for (const r of candidates) {
    const key = opts.filmKey(r);
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    const reason = ineligibilityReason(r, opts.excludedKeys, opts.filmKey);
    if (reason) {
      rejected.push({ title: r.title, reason });
      continue;
    }
    eligible.push(r);
  }

  eligible.sort(rank);

  const picks: SelectedArchive[] = [];
  const usedGenres = new Set<string>();
  for (const r of eligible) {
    if (picks.length >= max) break;
    const pg = primaryGenre(r);
    if (!pg) {
      rejected.push({ title: r.title, reason: "no primary genre" });
      continue;
    }
    if (usedGenres.has(pg)) {
      rejected.push({ title: r.title, reason: `genre "${pg}" already taken` });
      continue;
    }
    usedGenres.add(pg);
    picks.push(toSelected(r, "pick"));
  }

  return { picks, rejected };
}

/**
 * Curated-edition selection (ARCHIVES_PICKS): the owner's ordered tmdbId list is
 * editorial law — it BYPASSES genre-distinctness and the count floor/ceiling —
 * but NEVER bypasses eligibility (gate + platform + ledger). An id with no
 * enriched candidate, or one that fails eligibility, is rejected with a reason.
 */
export function selectArchivesManual(
  candidates: Release[],
  tmdbIds: number[],
  opts: SelectOptions
): SelectionResult {
  const byId = new Map<number, Release>();
  for (const r of candidates) if (r.tmdbId !== undefined) byId.set(r.tmdbId, r);

  const picks: SelectedArchive[] = [];
  const rejected: SelectionResult["rejected"] = [];
  for (const id of tmdbIds) {
    const r = byId.get(id);
    if (!r) {
      rejected.push({ title: `tmdb:${id}`, reason: "no enriched candidate for this tmdbId" });
      continue;
    }
    const reason = ineligibilityReason(r, opts.excludedKeys, opts.filmKey);
    if (reason) {
      rejected.push({ title: r.title, reason });
      continue;
    }
    picks.push(toSelected(r, "pick"));
  }
  return { picks, rejected };
}
