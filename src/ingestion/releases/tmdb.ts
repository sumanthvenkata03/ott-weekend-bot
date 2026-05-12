// src/ingestion/releases/tmdb.ts
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { config } from "../../shared/config.js";
import { log } from "../../shared/logger.js";
import type { Release, Language } from "../../shared/types.js";

const BASE_URL = "https://api.themoviedb.org/3";

// TMDb allows 40 req/10s on free tier. Be conservative: 4 req/s.
const throttle = pThrottle({ limit: 4, interval: 1000 });

const tmdbFetch = throttle(<T = unknown>(path: string, params: Record<string, string> = {}) => {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", config.TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return ofetch<T>(url.toString(), { retry: 2, retryDelay: 500 });
});

// Schema for TMDb discover/movie response
const TMDbMovieSchema = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string(),
  original_language: z.string(),
  overview: z.string(),
  release_date: z.string(),
  poster_path: z.string().nullable(),
  backdrop_path: z.string().nullable(),
  genre_ids: z.array(z.number()),
  popularity: z.number(),
  vote_average: z.number(),
  vote_count: z.number(),
});

const TMDbDiscoverResponseSchema = z.object({
  page: z.number(),
  results: z.array(TMDbMovieSchema),
  total_results: z.number(),
});

// TMDb genre mapping (movie genres only, cached from /genre/movie/list)
const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

// ISO 639-1 → our Language enum
const LANGUAGE_MAP: Record<string, Language> = {
  hi: "Hindi", te: "Telugu", ta: "Tamil", ml: "Malayalam",
  kn: "Kannada", mr: "Marathi", bn: "Bengali", pa: "Punjabi",
};

function mapLanguage(iso: string): Language {
  return LANGUAGE_MAP[iso] ?? "Other";
}

function posterUrl(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

function backdropUrl(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w1280${path}` : undefined;
}

/**
 * Discover Indian movies releasing in a date range.
 * Uses TMDb's region=IN filter to get India-specific releases.
 */
export async function discoverIndianReleases(
  startDate: string,  // YYYY-MM-DD
  endDate: string     // YYYY-MM-DD
): Promise<Release[]> {
  log.info(`Fetching TMDb releases ${startDate} → ${endDate}`);
  
  const langs = ["hi", "te", "ta", "ml", "kn", "mr", "bn", "pa"];
  const all: Release[] = [];
  
  for (const lang of langs) {
    try {
      const response = await tmdbFetch("/discover/movie", {
        "with_original_language": lang,
        "primary_release_date.gte": startDate,
        "primary_release_date.lte": endDate,
        "sort_by": "popularity.desc",
        "region": "IN",
        "include_adult": "false",
      });
      
      const parsed = TMDbDiscoverResponseSchema.parse(response);
      log.info(`  [${lang}] found ${parsed.results.length} releases`);
      
      for (const m of parsed.results) {
        all.push({
          id: `tmdb-${m.id}`,
          tmdbId: m.id,
          title: m.title,
          originalTitle: m.original_title !== m.title ? m.original_title : undefined,
          language: mapLanguage(m.original_language),
          isSeries: false,
          platform: [],           // populated in next sub-step via JustWatch / OMDb
          releaseDate: m.release_date,
          genre: m.genre_ids.map(id => GENRE_MAP[id]).filter(Boolean),
          cast: [],               // populated via /movie/{id}/credits in a later pass
          synopsis: m.overview,
          posterUrl: posterUrl(m.poster_path),
          backdropUrl: backdropUrl(m.backdrop_path),
          audioLanguages: [m.original_language],
          subtitleLanguages: [],
          sources: ["tmdb"],
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      log.warn(`Failed to fetch ${lang} releases`, err instanceof Error ? err.message : err);
    }
  }
  
  log.success(`TMDb: total ${all.length} Indian releases found`);
  return all;
}

// External IDs response from TMDb
const TMDbExternalIdsSchema = z.object({
  imdb_id: z.string().nullable().optional(),
});

/**
 * Fetch IMDb ID for a TMDb movie.
 * Returns null if not available.
 */
export async function getImdbId(tmdbId: number): Promise<string | null> {
  try {
    const response = await tmdbFetch(`/movie/${tmdbId}/external_ids`);
    const parsed = TMDbExternalIdsSchema.parse(response);
    return parsed.imdb_id || null;
  } catch (err) {
    log.warn(`Failed to fetch IMDb ID for TMDb ${tmdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}