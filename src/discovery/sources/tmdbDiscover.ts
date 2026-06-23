// src/discovery/sources/tmdbDiscover.ts
// TMDb "net": parametrized /discover/movie over a date range, paginated.
// Reuses the job pipeline's cached+throttled fetch helper so discovery and
// the production job share the same tmdb: cache namespace and rate budget.

import { z } from "zod";
import { tmdbFetchCached } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";
import type { DiscoveredFilm } from "../types.js";
import { normalizeTitle } from "../normalize.js";

// Page up to this many pages per language. Single-page would miss films,
// which defeats the purpose of a discovery net.
const MAX_PAGES = 5;
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
};

const TMDbMovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  original_language: z.string(),
  release_date: z.string().optional().default(""),
});
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

/**
 * Discover films for ONE language between from/to (inclusive ISO dates),
 * paginating up to MAX_PAGES. Never throws — returns [] on any error.
 */
async function discoverLanguage(
  language: string,
  code: string,
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  const films: DiscoveredFilm[] = [];
  try {
    let page = 1;
    let totalPages = 1;
    do {
      const raw = await tmdbFetchCached<unknown>(
        "/discover/movie",
        {
          with_original_language: code,
          "primary_release_date.gte": from,
          "primary_release_date.lte": to,
          sort_by: "primary_release_date.asc",
          region: "IN",
          include_adult: "false",
          page: String(page),
        },
        TMDB_DISCOVER_TTL
      );
      const parsed = TMDbDiscoverResponseSchema.parse(raw);
      totalPages = parsed.total_pages;
      for (const m of parsed.results) {
        const releaseDate = m.release_date || undefined;
        const year = m.release_date ? yearOf(m.release_date) : undefined;
        films.push({
          title: m.title,
          normalizedTitle: normalizeTitle(m.title),
          ...(year !== undefined ? { year } : {}),
          language,
          ...(releaseDate ? { releaseDate } : {}),
          tmdbId: m.id,
          foundIn: ["tmdb"],
          perSource: {
            tmdb: {
              tmdbId: m.id,
              title: m.title,
              ...(releaseDate ? { releaseDate } : {}),
              language,
            },
          },
        });
      }
      page += 1;
    } while (page <= totalPages && page <= MAX_PAGES);
    log.info(`  TMDb [${language}/${code}] ${films.length} films (≤${MAX_PAGES}p)`);
  } catch (err) {
    log.warn(`TMDb discover failed for ${language}`, err instanceof Error ? err.message : err);
    return [];
  }
  return films;
}

/**
 * TMDb net entry point. Runs one paginated discover per requested language.
 * Unknown languages are skipped with a warning. Never throws.
 */
export async function discoverTmdb(
  languages: string[],
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  const out: DiscoveredFilm[] = [];
  for (const language of languages) {
    const code = LANGUAGE_TO_TMDB[language];
    if (!code) {
      log.warn(`TMDb: no language code for "${language}" — skipping`);
      continue;
    }
    const films = await discoverLanguage(language, code, from, to);
    out.push(...films);
  }
  return out;
}
