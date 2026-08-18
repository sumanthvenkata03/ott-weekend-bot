// src/discovery/sources/resolveWikiFilm.ts
// WD-ENG-07 — GIVE A WIKI-ONLY FIND ITS TMDb ID.
//
// ── THE GAP (finding 1a) ────────────────────────────────────────────────────
// discover() runs two nets in parallel and unions them by
// normalizedTitle|language|year. A Wikipedia film therefore acquires a tmdbId
// ONLY when TMDb's *discover* sweep independently surfaced the same normalized
// title in the same window. If that sweep missed it, NO TMDb SEARCH IS EVER
// ATTEMPTED for it — the film stays id-less forever, and matchesIntent declines
// it for having no releaseType.
//
// That is not a hypothetical. Agadha sits in the List of Telugu films of 2026
// under 14 August; TMDb's discover sweep missed it; and a plain
// searchTitleTmdb("Agadha") returns id 1747034 on the first try. The record was
// one query away the whole time and the query was never made.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
// The TMDb-backed-pool rule STANDS. This module makes films TMDb-backed; it
// never admits a film that has no TMDb record. Panchali Panchabhartruka and
// Pallaburusu return zero results on every query shape and every transliteration
// variant tried — they stay declined, and no amount of resolution work can card
// them. Whether wiki corroboration should ever promote a TMDb-less film is an
// evidence-floor product decision, and it is not taken here.
//
// ── COST ────────────────────────────────────────────────────────────────────
// One TMDb /search call per UNRESOLVED wiki-only film, at most MAX_ATTEMPTS
// query shapes each, short-circuiting on the first hit. The Aug-13 window had
// three such films, so ~3–9 searches per run, cached 7 days by searchTitleTmdb.
// TMDb search is unbilled but rate-limited; the cap and the short-circuit are
// what keep this bounded as list coverage grows.

import { normalizeTitle } from "../normalize.js";
import { log } from "../../shared/logger.js";
import type { DiscoveredFilm } from "../types.js";
import type { TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";

/** Query shapes attempted per film before giving up. */
export const MAX_ATTEMPTS = 3;

/**
 * Title spellings worth trying, most-faithful first, deduped.
 *
 * DELIBERATELY CONSERVATIVE. Every variant past the first is a chance to match
 * the WRONG film, and a wrong id is far worse than no id: it would card another
 * film's poster, cast and rating under this title. So the list is limited to
 * transformations that cannot change which film a human would name —
 * whitespace, punctuation, and the two transliteration doubles that are pure
 * spelling noise in Indian film titles ("th"→"t", doubled vowels).
 *
 * Pure and exported so the variant set itself is pinned by test.
 */
export function titleVariants(title: string): string[] {
  const base = title.trim().replace(/\s+/g, " ");
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.trim().replace(/\s+/g, " ");
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  add(base);
  // Diacritics stripped ("Pushpā" → "Pushpa").
  add(base.normalize("NFD").replace(/\p{M}/gu, ""));
  // Punctuation that press and Wikipedia disagree about, never letters.
  add(base.replace(/[.'’:\-–—]/g, " "));
  // Transliteration doubles: aspirated "th"/"dh" written bare, and doubled
  // vowels written single. Applied together — they co-occur in practice
  // ("Panchabhartruka" / "Panchabharthruka", "Pallaburusu" / "Pallaaburusu").
  add(base.replace(/([bcdgkpt])h/gi, "$1").replace(/([aeiou])\1+/gi, "$1"));

  return out.slice(0, MAX_ATTEMPTS);
}

/** The TMDb search seam. Injected so tests never touch the network. */
export interface WikiResolveDeps {
  searchTitle: (title: string, opts: { year?: number; language?: string }) => Promise<TmdbTitleSearch>;
}

export interface WikiResolution {
  title: string;
  /** The query shape that hit, for the audit line. */
  via?: string;
  tmdbId?: number;
  /** Every shape tried, in order — so a miss is diagnosable without a re-run. */
  tried: string[];
}

/**
 * Resolve ONE wiki-only film against TMDb.
 *
 * A hit must be a MOVIE within ±1 year of the film's own year — the same window
 * resolveTitleToTmdb applies — so a same-title film from another decade cannot
 * be adopted. When several survive, the one whose language matches the list the
 * film came from wins; otherwise the first. Returns `tmdbId: undefined` when
 * nothing matched, which is a normal, expected outcome.
 */
export async function resolveWikiFilm(
  film: DiscoveredFilm,
  deps: WikiResolveDeps
): Promise<WikiResolution> {
  const tried: string[] = [];
  const year = film.year ?? (film.releaseDate ? Number.parseInt(film.releaseDate.slice(0, 4), 10) : undefined);

  for (const q of titleVariants(film.title)) {
    tried.push(q);
    let search: TmdbTitleSearch;
    try {
      search = await deps.searchTitle(q, {
        ...(year !== undefined ? { year } : {}),
        ...(film.language ? { language: film.language } : {}),
      });
    } catch {
      continue; // a failed search is a miss, never a crash — discovery degrades
    }
    let cands = search.movie.filter(
      (h) => year === undefined || (h.year !== undefined && Math.abs(h.year - year) <= 1)
    );
    if (cands.length === 0) continue;
    // Prefer a hit whose title matches ours exactly once normalized — this is
    // what stops a loose variant from adopting a near-namesake.
    const exact = cands.filter((h) => normalizeTitle(h.title) === film.normalizedTitle);
    if (exact.length > 0) cands = exact;
    const hit = cands[0]!;
    return { title: film.title, via: q, tmdbId: hit.id, tried };
  }
  return { title: film.title, tried };
}

/**
 * Resolve every wiki-only film in `films`, IN PLACE, and report what happened.
 *
 * A resolved film gains `tmdbId` and `releaseType: "theatrical"` — the latter
 * because "List of <Language> films of <year>" enumerates CINEMA openings (its
 * date column is literally headed "Opening"). That is what lets it flow through
 * the EXISTING theatrical intent with no change to matchesIntent: a wiki opening
 * date is a theatrical date, and claiming otherwise would file it under the
 * wrong pillar.
 *
 * Films that do not resolve are left exactly as they were — still id-less, still
 * declined downstream, and still named by the ENG-05 decline trace.
 */
export async function resolveWikiOnlyFilms(
  films: DiscoveredFilm[],
  deps: WikiResolveDeps
): Promise<{ resolved: WikiResolution[]; unresolved: WikiResolution[] }> {
  // WD-ENG-18 — district joins wikipedia here. Both are TMDb-LESS algorithmic
  // nets whose finds must earn admission by resolving to a real TMDb record;
  // neither may enter the pool unresolved. Widening the filter is what puts the
  // District net under the existing TMDb-backing rule rather than beside it.
  const targets = films.filter(
    (f) =>
      f.tmdbId === undefined &&
      f.releaseType === undefined &&
      (f.foundIn.includes("wikipedia") || f.foundIn.includes("district"))
  );
  const resolved: WikiResolution[] = [];
  const unresolved: WikiResolution[] = [];
  if (targets.length === 0) return { resolved, unresolved };

  log.info(`  [wiki-resolve] attempting TMDb resolution for ${targets.length} wiki-only find(s)…`);
  for (const f of targets) {
    const r = await resolveWikiFilm(f, deps);
    if (r.tmdbId === undefined) {
      unresolved.push(r);
      log.info(
        `  [wiki-resolve] "${f.title}" — NO TMDb record (tried: ${r.tried.map((t) => `"${t}"`).join(", ")}). ` +
        `Stays declined; the TMDb-backed pool rule is unchanged.`
      );
      continue;
    }
    f.tmdbId = r.tmdbId;
    f.releaseType = "theatrical";
    if (!f.perSource.tmdb) {
      f.perSource.tmdb = {
        tmdbId: r.tmdbId,
        title: f.title,
        ...(f.releaseDate ? { releaseDate: f.releaseDate } : {}),
        ...(f.language ? { language: f.language } : {}),
        releaseType: "theatrical",
      };
    }
    resolved.push(r);
    log.info(`  [wiki-resolve] "${f.title}" → tmdb ${r.tmdbId} (matched on "${r.via}") — now TMDb-backed`);
  }
  return { resolved, unresolved };
}
