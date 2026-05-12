// src/ingestion/releases/tmdb.ts
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { config } from "../../shared/config.js";
import { log } from "../../shared/logger.js";
import { cached } from "../../shared/cache.js";
import type { Release, Language, Platform } from "../../shared/types.js";

const BASE_URL = "https://api.themoviedb.org/3";
const throttle = pThrottle({ limit: 4, interval: 1000 });

const tmdbFetchRaw = throttle(<T = unknown>(path: string, params: Record<string, string> = {}) => {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", config.TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return ofetch<T>(url.toString(), { retry: 2, retryDelay: 500 });
});

function tmdbFetchCached<T>(path: string, params: Record<string, string>, ttlSeconds: number): Promise<T> {
  const key = `tmdb:${path}:${new URLSearchParams(params).toString()}`;
  return cached(key, () => tmdbFetchRaw<T>(path, params), { ttlSeconds });
}

// --- Schemas ---
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
const TMDbExternalIdsSchema = z.object({
  imdb_id: z.string().nullable().optional(),
});

// Watch providers (JustWatch via TMDb)
const TMDbProviderSchema = z.object({
  provider_id: z.number(),
  provider_name: z.string(),
});
const TMDbProvidersForCountrySchema = z.object({
  link: z.string().optional(),
  flatrate: z.array(TMDbProviderSchema).optional(),
  rent: z.array(TMDbProviderSchema).optional(),
  buy: z.array(TMDbProviderSchema).optional(),
  free: z.array(TMDbProviderSchema).optional(),
  ads: z.array(TMDbProviderSchema).optional(),
});
const TMDbProvidersResponseSchema = z.object({
  id: z.number(),
  results: z.record(z.string(), TMDbProvidersForCountrySchema).optional(),
});

// --- Maps ---
const GENRE_MAP: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Science Fiction",
  10770: "TV Movie", 53: "Thriller", 10752: "War", 37: "Western",
};

const LANGUAGE_MAP: Record<string, Language> = {
  hi: "Hindi", te: "Telugu", ta: "Tamil", ml: "Malayalam",
  kn: "Kannada", mr: "Marathi", bn: "Bengali", pa: "Punjabi",
};

// TMDb/JustWatch provider names → our Platform enum
const PROVIDER_MAP: Record<string, Platform> = {
  "Netflix": "Netflix",
  "Amazon Prime Video": "Prime Video",
  "Amazon Video": "Prime Video",
  "Jio Hotstar": "JioHotstar",
  "JioHotstar": "JioHotstar",
  "Disney Plus Hotstar": "JioHotstar",
  "Hotstar": "JioHotstar",
  "aha": "Aha",
  "Aha": "Aha",
  "Sony LIV": "SonyLIV",
  "SonyLIV": "SonyLIV",
  "Zee5": "ZEE5",
  "ZEE5": "ZEE5",
  "Sun NXT": "Sun NXT",
  "Manorama Max": "ManoramaMAX",
  "Hoichoi": "Hoichoi",
  "Lionsgate Play": "Lionsgate Play",
  "Apple TV Plus": "Apple TV+",
  "Apple TV+": "Apple TV+",
  "MUBI": "MUBI",
  "Chaupal": "Chaupal",
  "Planet Marathi": "Planet Marathi",
};

function mapLanguage(iso: string): Language {
  return LANGUAGE_MAP[iso] ?? "Other";
}
function mapProvider(name: string): Platform | null {
  return PROVIDER_MAP[name] ?? null;
}
function posterUrl(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}
function backdropUrl(path: string | null): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w1280${path}` : undefined;
}

/** Discover Indian films releasing in a date range. */
export async function discoverIndianReleases(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  log.info(`Fetching TMDb releases ${startDate} → ${endDate}`);
  
  const langs = ["hi", "te", "ta", "ml", "kn", "mr", "bn", "pa"];
  const all: Release[] = [];
  
  for (const lang of langs) {
    try {
      const response = await tmdbFetchCached<unknown>(
        "/discover/movie",
        {
          "with_original_language": lang,
          "primary_release_date.gte": startDate,
          "primary_release_date.lte": endDate,
          "sort_by": "popularity.desc",
          "region": "IN",
          "include_adult": "false",
        },
        6 * 60 * 60   // 6 hour TTL for discover results
      );
      
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
          platform: [],
          releaseDate: m.release_date,
          genre: m.genre_ids.map(id => GENRE_MAP[id]).filter(Boolean),
          cast: [],
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

/** Fetch IMDb ID for a TMDb movie. */
export async function getImdbId(tmdbId: number): Promise<string | null> {
  try {
    const response = await tmdbFetchCached<unknown>(
      `/movie/${tmdbId}/external_ids`,
      {},
      30 * 24 * 60 * 60  // 30 days — IMDb IDs basically never change
    );
    const parsed = TMDbExternalIdsSchema.parse(response);
    return parsed.imdb_id || null;
  } catch (err) {
    log.warn(`Failed to fetch IMDb ID for TMDb ${tmdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 
 * Fetch streaming platforms for a TMDb movie in India.
 * Uses JustWatch data via TMDb's /watch/providers endpoint.
 */
export async function getStreamingPlatforms(tmdbId: number): Promise<Platform[]> {
  try {
    const response = await tmdbFetchCached<unknown>(
      `/movie/${tmdbId}/watch/providers`,
      {},
      24 * 60 * 60  // 24h — platform availability shifts but not by the hour
    );
    const parsed = TMDbProvidersResponseSchema.parse(response);
    const india = parsed.results?.["IN"];
    if (!india) return [];
    
    // Combine all access modes (subscription / free / ads — skip rent/buy for OTT page focus)
    const providers = [
      ...(india.flatrate ?? []),
      ...(india.free ?? []),
      ...(india.ads ?? []),
    ];
    
    const platforms: Platform[] = [];
    const seen = new Set<Platform>();
    for (const p of providers) {
      const mapped = mapProvider(p.provider_name);
      if (mapped && !seen.has(mapped)) {
        platforms.push(mapped);
        seen.add(mapped);
      }
    }
    return platforms;
  } catch (err) {
    log.warn(`Failed to fetch providers for TMDb ${tmdbId}`, err instanceof Error ? err.message : err);
    return [];
  }
}