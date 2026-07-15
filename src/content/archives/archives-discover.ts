// src/content/archives/archives-discover.ts
// TBSI Archives discover net — the COARSE candidate surface only.
//
// Per ruling R3 the discover call is deliberately loose: vote_average.gte=7.0,
// vote_count.gte=50 on TMDb (server-side). This is a wide net, NOT the quality
// bar. The REAL gate runs post-enrichment on IMDb (imdbRating ≥ 7.3 AND
// imdbVotes ≥ 2000) in archives-select.ts — the printed IMDb vote count is the
// honesty device, so only IMDb-sealed films can ship.
//
// Films must be OLDER than ARCHIVE_MIN_AGE_YEARS (primary_release_date ≤ the
// cutoff). We reuse the job pipeline's cached+throttled tmdbFetchCached so we
// share the tmdb: cache namespace and rate budget, then hand the raw stubs to
// the shared enrichReleases() seam (IMDb → platforms → credits → ratings).

import { z } from "zod";
import { tmdbFetchCached, mapLanguage, posterUrl } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";
import type { Release, Language } from "../../shared/types.js";
import { LANGUAGE_TO_TMDB } from "../../discovery/sources/tmdbDiscover.js";

// TMDb genre id → display name. A local copy (the ingestion GENRE_MAP is
// module-private); Archives prints the PRIMARY genre first in the kicker, so it
// needs names, not ids.
const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

// The COARSE bar — a wide net, not the quality gate (see header + R3).
const COARSE_VOTE_AVERAGE = "7.0";
const COARSE_VOTE_COUNT = "50";
// Discover results for a fixed historical window shift slowly — 24h TTL.
const ARCHIVES_DISCOVER_TTL = 24 * 60 * 60;
// Pages per language. 3 * 20 = 60 candidates/language pre-gate is plenty to find
// 1 gate-passing pick; never a silent cap (we WARN if TMDb has more).
const MAX_PAGES = 3;

const TMDbMovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().optional().default(""),
  original_language: z.string().optional().default(""),
  overview: z.string().optional().default(""),
  release_date: z.string().optional().default(""),
  poster_path: z.string().nullable().optional(),
  genre_ids: z.array(z.number()).optional().default([]),
  popularity: z.number().optional().default(0),
  vote_average: z.number().optional().default(0),
  vote_count: z.number().optional().default(0),
});
const TMDbDiscoverResponseSchema = z.object({
  page: z.number(),
  results: z.array(TMDbMovieSchema),
  total_pages: z.number(),
  total_results: z.number(),
});
type TMDbMovie = z.infer<typeof TMDbMovieSchema>;

/** Build an un-enriched Release stub from a discover row (platforms/ratings/credits
 *  are filled later by enrichReleases). Carries the TMDb vote fields the coarse
 *  net needs and the genre names the kicker prints. */
function stubFromMovie(m: TMDbMovie, language: Language): Release {
  const poster = posterUrl(m.poster_path ?? null);
  return {
    id: `tmdb-${m.id}`,
    tmdbId: m.id,
    title: m.title,
    ...(m.original_title && m.original_title !== m.title ? { originalTitle: m.original_title } : {}),
    language,
    isSeries: false,
    platform: [],
    releaseDate: m.release_date,
    genre: m.genre_ids.map((id) => GENRE_MAP[id]).filter((g): g is string => Boolean(g)),
    cast: [],
    synopsis: m.overview,
    ...(poster ? { posterUrl: poster } : {}),
    subtitleLanguages: [],
    tmdbPopularity: m.popularity,
    tmdbVoteAverage: m.vote_average,
    tmdbVoteCount: m.vote_count,
    sources: ["tmdb-archives"],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Discover coarse Archives candidates for ONE language older than the cutoff.
 * `cutoffDate` is an ISO "yyyy-MM-dd" — the latest primary_release_date allowed
 * (today − ARCHIVE_MIN_AGE_YEARS). Never throws; returns [] on any failure.
 */
export async function discoverArchivesLanguage(
  language: Language,
  cutoffDate: string
): Promise<Release[]> {
  const code = LANGUAGE_TO_TMDB[language];
  if (!code) {
    log.warn(`Archives: no TMDb code for "${language}" — skipping`);
    return [];
  }

  const stubs: Release[] = [];
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
          sort_by: "vote_count.desc",
          "primary_release_date.lte": cutoffDate,
          "vote_average.gte": COARSE_VOTE_AVERAGE,
          "vote_count.gte": COARSE_VOTE_COUNT,
          page: String(page),
        },
        ARCHIVES_DISCOVER_TTL
      );
      const parsed = TMDbDiscoverResponseSchema.parse(raw);
      totalPages = parsed.total_pages;
      for (const m of parsed.results) {
        if (!m.release_date) continue; // no date → can't verify age
        stubs.push(stubFromMovie(m, language));
      }
      page += 1;
    } while (page <= totalPages && page <= MAX_PAGES);

    if (totalPages > MAX_PAGES) {
      log.info(
        `  Archives [${language}] coarse net: kept ${stubs.length} (top ${MAX_PAGES} pages of ${totalPages} — sorted by votes, deeper pages are weaker)`
      );
    } else {
      log.info(`  Archives [${language}] coarse net: ${stubs.length} candidate(s)`);
    }
  } catch (err) {
    log.warn(`Archives discover failed for ${language}`, err instanceof Error ? err.message : err);
    return [];
  }
  return stubs;
}

// ── Fetch a single film by tmdbId (curated ARCHIVES_PICKS + ARCHIVES_TREASURE) ──
// The owner's dials name arbitrary tmdbIds that may sit outside the rotation
// languages, so they can't come from the discover net — fetch each directly.

const TMDbGenreSchema = z.object({ id: z.number(), name: z.string() });
const TMDbMovieDetailsSchema = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().optional().default(""),
  original_language: z.string().optional().default(""),
  overview: z.string().optional().default(""),
  release_date: z.string().optional().default(""),
  poster_path: z.string().nullable().optional(),
  genres: z.array(TMDbGenreSchema).optional().default([]),
  popularity: z.number().optional().default(0),
  vote_average: z.number().optional().default(0),
  vote_count: z.number().optional().default(0),
});

/**
 * Build an un-enriched Release stub for ONE tmdbId via /movie/{id}. Language is
 * mapped from original_language (falls back to "Other"). Returns null on any
 * failure. Enrichment (platforms/ratings/credits) is the caller's job.
 */
export async function fetchArchivesStubById(tmdbId: number): Promise<Release | null> {
  try {
    const raw = await tmdbFetchCached<unknown>(`/movie/${tmdbId}`, {}, ARCHIVES_DISCOVER_TTL);
    const d = TMDbMovieDetailsSchema.parse(raw);
    const poster = posterUrl(d.poster_path ?? null);
    return {
      id: `tmdb-${d.id}`,
      tmdbId: d.id,
      title: d.title,
      ...(d.original_title && d.original_title !== d.title ? { originalTitle: d.original_title } : {}),
      language: mapLanguage(d.original_language),
      isSeries: false,
      platform: [],
      releaseDate: d.release_date,
      genre: d.genres.map((g) => g.name).filter(Boolean),
      cast: [],
      synopsis: d.overview,
      ...(poster ? { posterUrl: poster } : {}),
      subtitleLanguages: [],
      tmdbPopularity: d.popularity,
      tmdbVoteAverage: d.vote_average,
      tmdbVoteCount: d.vote_count,
      sources: ["tmdb-archives"],
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.warn(`Archives fetch-by-id failed for tmdb ${tmdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Re-export the language→code map (7 active languages minus Bengali live in the
 *  rotation; see archives-select) for callers that need to validate a language. */
export { LANGUAGE_TO_TMDB, mapLanguage };
