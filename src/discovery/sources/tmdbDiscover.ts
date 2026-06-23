// src/discovery/sources/tmdbDiscover.ts
// TMDb "net": parametrized /discover/movie over a date range, paginated.
// Reuses the job pipeline's cached+throttled fetch helper so discovery and
// the production job share the same tmdb: cache namespace and rate budget.
//
// TWO passes per language, unioned by tmdbId:
//   1. THEATRICAL — primary_release_date in range (the canonical release).
//   2. DIGITAL    — with_release_type=4 + release_date in range. This mirrors
//      the proven discoverIndianOTTArrivals pattern and catches OTT-only
//      films whose primary (theatrical) date sits outside the window.
// A film qualifies if EITHER pass returns it. We TRUST TMDb's server-side
// date filter for the digital pass and do NOT re-filter on m.release_date
// (a digital-only film's primary date can legitimately fall outside [from,to]
// — re-filtering would drop the exact OTT films this pass exists to catch).

import { z } from "zod";
import { tmdbFetchCached } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";
import type { DiscoveredFilm, ReleaseType, TmdbCoverage, TmdbNetResult } from "../types.js";
import { normalizeTitle } from "../normalize.js";

// Hard ceiling on pages fetched per pass per language. Beyond this we WARN
// loudly and stop — never a silent cap. 25 * 20 = 500 films/pass covers a
// full year for every language (worst seen: hi=17 pages).
const HARD_PAGE_CEILING = 25;
// 6h — discover results shift slowly; matches the job pipeline's TTL.
const TMDB_DISCOVER_TTL = 21600;

// Human language name → TMDb with_original_language (ISO 639-1).
export const LANGUAGE_TO_TMDB: Record<string, string> = {
  Telugu: "te",
  Tamil: "ta",
  Malayalam: "ml",
  Kannada: "kn",
  Hindi: "hi",
  Bengali: "bn",
  Marathi: "mr",
  Punjabi: "pa",
};

const TMDbMovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  release_date: z.string().optional().default(""),
});
type TMDbMovie = z.infer<typeof TMDbMovieSchema>;

const TMDbDiscoverResponseSchema = z.object({
  page: z.number(),
  results: z.array(TMDbMovieSchema),
  total_pages: z.number(),
  total_results: z.number(),
});

function yearOf(releaseDate: string): number | undefined {
  const y = Number.parseInt(releaseDate.slice(0, 4), 10);
  return Number.isFinite(y) && y > 1900 ? y : undefined;
}

function yearsInRange(from: string, to: string): number[] {
  const a = Number.parseInt(from.slice(0, 4), 10);
  const b = Number.parseInt(to.slice(0, 4), 10);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

/**
 * Run ONE discover pass, paginating to total_pages (capped at
 * HARD_PAGE_CEILING with a loud WARN). Returns the raw movies; never throws.
 */
async function discoverPass(
  code: string,
  dateParams: Record<string, string>,
  label: string
): Promise<TMDbMovie[]> {
  const movies: TMDbMovie[] = [];
  try {
    let page = 1;
    let totalPages = 1;
    do {
      const raw = await tmdbFetchCached<unknown>(
        "/discover/movie",
        {
          with_original_language: code,
          region: "IN",
          include_adult: "false",
          sort_by: "primary_release_date.asc",
          ...dateParams,
          page: String(page),
        },
        TMDB_DISCOVER_TTL
      );
      const parsed = TMDbDiscoverResponseSchema.parse(raw);
      totalPages = parsed.total_pages;
      movies.push(...parsed.results);
      page += 1;
    } while (page <= totalPages && page <= HARD_PAGE_CEILING);

    if (totalPages > HARD_PAGE_CEILING) {
      const skipped = (totalPages - HARD_PAGE_CEILING) * 20;
      log.warn(
        `⚠ TMDb ${label} TRUNCATED: total_pages=${totalPages} but capped at ${HARD_PAGE_CEILING} ` +
          `(~${skipped} films NOT fetched — narrow the date range)`
      );
    }
  } catch (err) {
    log.warn(`TMDb ${label} pass failed`, err instanceof Error ? err.message : err);
    return [];
  }
  return movies;
}

/**
 * Discover films for ONE language between from/to (inclusive ISO dates).
 * Runs the theatrical + digital passes and unions them by tmdbId. Never throws.
 */
async function discoverLanguage(
  language: string,
  code: string,
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  const theatrical = await discoverPass(
    code,
    { "primary_release_date.gte": from, "primary_release_date.lte": to },
    `[${language}/${code}] theatrical`
  );
  const digital = await discoverPass(
    code,
    { with_release_type: "4", "release_date.gte": from, "release_date.lte": to },
    `[${language}/${code}] digital`
  );

  // Union by tmdbId — same film = same id across passes.
  const byId = new Map<number, { movie: TMDbMovie; theatrical: boolean; digital: boolean }>();
  for (const m of theatrical) {
    const e = byId.get(m.id) ?? { movie: m, theatrical: false, digital: false };
    e.theatrical = true;
    e.movie = m;
    byId.set(m.id, e);
  }
  for (const m of digital) {
    const e = byId.get(m.id) ?? { movie: m, theatrical: false, digital: false };
    e.digital = true;
    byId.set(m.id, e);
  }

  const films: DiscoveredFilm[] = [];
  for (const [id, e] of byId) {
    const m = e.movie;
    const releaseType: ReleaseType =
      e.theatrical && e.digital ? "both" : e.theatrical ? "theatrical" : "digital";
    const releaseDate = m.release_date || undefined;
    const year = m.release_date ? yearOf(m.release_date) : undefined;
    // A2 honesty flag: a digital-only film's shown date is TMDb's PRIMARY date,
    // which can fall outside the queried window even though TMDb confirmed an
    // in-range digital release. Flag those so the cinema date isn't mistaken
    // for the streaming date.
    const outOfRange = releaseDate ? releaseDate < from || releaseDate > to : false;
    const approximate = releaseType === "digital" && outOfRange;

    films.push({
      title: m.title,
      normalizedTitle: normalizeTitle(m.title),
      ...(year !== undefined ? { year } : {}),
      language,
      ...(releaseDate ? { releaseDate } : {}),
      ...(approximate ? { approximateDate: true } : {}),
      releaseType,
      tmdbId: id,
      ...(approximate ? { note: "in-range digital release; date shown is TMDb primary date" } : {}),
      foundIn: ["tmdb"],
      perSource: {
        tmdb: {
          tmdbId: id,
          title: m.title,
          ...(releaseDate ? { releaseDate } : {}),
          language,
          releaseType,
        },
      },
    });
  }

  const both = films.filter((f) => f.releaseType === "both").length;
  const dig = films.filter((f) => f.releaseType === "digital").length;
  log.info(
    `  TMDb [${language}/${code}] ${films.length} films ` +
      `(theatrical ${theatrical.length}, digital ${digital.length} → ${dig} digital-only, ${both} both)`
  );
  return films;
}

/**
 * TMDb net entry point. Runs the two-pass discover per requested language and
 * reports per-(language, year) coverage for the cross-net sanity guard.
 * Unknown languages are skipped with a warning. Never throws.
 */
export async function discoverTmdb(
  languages: string[],
  from: string,
  to: string
): Promise<TmdbNetResult> {
  const films: DiscoveredFilm[] = [];
  for (const language of languages) {
    const code = LANGUAGE_TO_TMDB[language];
    if (!code) {
      log.warn(`TMDb: no language code for "${language}" — skipping`);
      continue;
    }
    films.push(...(await discoverLanguage(language, code, from, to)));
  }

  // Per-(language, year) counts for the years the range touches.
  const coverage: TmdbCoverage[] = [];
  for (const language of languages) {
    if (!LANGUAGE_TO_TMDB[language]) continue;
    for (const year of yearsInRange(from, to)) {
      const count = films.filter((f) => f.language === language && f.year === year).length;
      coverage.push({ language, year, count });
    }
  }

  return { films, coverage };
}
