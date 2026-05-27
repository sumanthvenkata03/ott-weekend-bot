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

// Movie details — for spoken_languages + original_language (Phase 5.5)
const TMDbSpokenLanguageSchema = z.object({
  iso_639_1: z.string(),
  english_name: z.string().optional(),
});
const TMDbMovieDetailsSchema = z.object({
  id: z.number(),
  original_language: z.string(),
  spoken_languages: z.array(TMDbSpokenLanguageSchema),
});

// Credits — for cast (by billing order) + crew (find composer) (Phase 5.5)
const TMDbCastEntrySchema = z.object({
  name: z.string(),
  order: z.number(),
});
const TMDbCrewEntrySchema = z.object({
  name: z.string(),
  job: z.string(),
  department: z.string().optional(),
});
const TMDbCreditsSchema = z.object({
  id: z.number(),
  cast: z.array(TMDbCastEntrySchema),
  crew: z.array(TMDbCrewEntrySchema),
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
          // audioLanguages populated later by getCreditsAndLanguages (Phase 5.5)
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

/**
 * Discover Indian films that landed on OTT in a date range.
 * Uses TMDb's release_type=4 filter (Digital releases).
 *
 * Note: TMDb's release_type data is uneven for India — many regional films
 * don't have it populated. We treat this as "supplementary signal" alongside
 * the standard discover call, not a replacement.
 */
export async function discoverIndianOTTArrivals(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  log.info(`Fetching TMDb OTT arrivals ${startDate} → ${endDate}`);
  
  const langs = ["hi", "te", "ta", "ml", "kn", "mr", "bn", "pa"];
  const all: Release[] = [];
  
  for (const lang of langs) {
    try {
      const response = await tmdbFetchCached<unknown>(
        "/discover/movie",
        {
          "with_original_language": lang,
          "with_release_type": "4",  // 4 = Digital
          "release_date.gte": startDate,
          "release_date.lte": endDate,
          "sort_by": "popularity.desc",
          "region": "IN",
          "include_adult": "false",
        },
        6 * 60 * 60
      );
      
      const parsed = TMDbDiscoverResponseSchema.parse(response);
      if (parsed.results.length > 0) {
        log.info(`  [${lang}] ${parsed.results.length} OTT arrivals`);
      }
      
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
          // audioLanguages populated later by getCreditsAndLanguages (Phase 5.5)
          subtitleLanguages: [],
          sources: ["tmdb-ott"],
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      log.warn(`OTT arrivals fetch failed for ${lang}`, err instanceof Error ? err.message : err);
    }
  }
  
  log.success(`TMDb OTT arrivals: ${all.length} films`);
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

// ISO 639-1 code → display name. Indian languages first; English-language
// names for others. Used for audioLanguages display (Phase 5.5).
const LANG_DISPLAY: Record<string, string> = {
  hi: "Hindi", te: "Telugu", ta: "Tamil", ml: "Malayalam",
  kn: "Kannada", mr: "Marathi", bn: "Bengali", pa: "Punjabi",
  gu: "Gujarati", or: "Odia", as: "Assamese", ur: "Urdu",
  en: "English", ja: "Japanese", ko: "Korean", zh: "Chinese",
  es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", ru: "Russian", ar: "Arabic", th: "Thai",
  id: "Indonesian", vi: "Vietnamese", ne: "Nepali", si: "Sinhala",
};
function isoToDisplay(iso: string): string {
  return LANG_DISPLAY[iso.toLowerCase()] ?? iso.toUpperCase();
}

export interface CreditsAndLanguages {
  leadCast: string[];
  musicDirector?: string;
  audioLanguages?: {
    original: string;
    dubbed?: string[];
  };
}

/**
 * Phase 5.5 — fetch top-2 billed cast, music composer, and audio language
 * structure from TMDb in one shot.
 *
 * Calls /movie/{id} (for spoken_languages + original_language) and
 * /movie/{id}/credits (for cast.order + crew.job) in parallel.
 *
 * Returns an empty leadCast on error — the caller treats this as "no
 * Phase 5.5 enrichment available" and skips rendering the affected line.
 */
export async function getCreditsAndLanguages(tmdbId: number): Promise<CreditsAndLanguages> {
  try {
    const [movieRaw, creditsRaw] = await Promise.all([
      tmdbFetchCached<unknown>(`/movie/${tmdbId}`, {}, 30 * 24 * 60 * 60),
      tmdbFetchCached<unknown>(`/movie/${tmdbId}/credits`, {}, 30 * 24 * 60 * 60),
    ]);
    const details = TMDbMovieDetailsSchema.parse(movieRaw);
    const credits = TMDbCreditsSchema.parse(creditsRaw);

    // Top-2 billed cast (lowest `order` value wins; ties stable-sorted by name)
    const leadCast = credits.cast
      .slice()
      .sort((a, b) => a.order - b.order)
      .slice(0, 2)
      .map(c => c.name);

    // Composer: prefer "Original Music Composer" (TMDb canonical), fall back
    // to "Music" which Indian-film credits often use instead.
    const composer =
      credits.crew.find(c => c.job === "Original Music Composer") ??
      credits.crew.find(c => c.job === "Music");

    // Audio language structure: original is the film's primary track;
    // dubbed is everything else in spoken_languages.
    const originalIso = details.original_language;
    const dubbedIsos = details.spoken_languages
      .map(l => l.iso_639_1)
      .filter(iso => iso && iso !== originalIso);
    const dubbedDisplay = Array.from(new Set(dubbedIsos.map(isoToDisplay)));

    const result: CreditsAndLanguages = {
      leadCast,
      audioLanguages: {
        original: isoToDisplay(originalIso),
        ...(dubbedDisplay.length > 0 ? { dubbed: dubbedDisplay } : {}),
      },
    };
    if (composer) result.musicDirector = composer.name;
    return result;
  } catch (err) {
    log.warn(
      `Credits+languages fetch failed for TMDb ${tmdbId}`,
      err instanceof Error ? err.message : err
    );
    return { leadCast: [] };
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