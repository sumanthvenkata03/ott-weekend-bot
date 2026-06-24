// src/ingestion/releases/tmdb.ts
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { log } from "../../shared/logger.js";
import { cached } from "../../shared/cache.js";
import type { Release, Language, Platform } from "../../shared/types.js";

const BASE_URL = "https://api.themoviedb.org/3";
const throttle = pThrottle({ limit: 4, interval: 1000 });

const tmdbFetchRaw = throttle(<T = unknown>(path: string, params: Record<string, string> = {}) => {
  // Read the key at CALL time, never at module load — importing this module must
  // stay side-effect-free so any consumer (e.g. src/discovery) can pull it in
  // without a missing key killing the process. The throw lives HERE, on the
  // fetch path, not at top level. (The job pipeline still imports shared/config
  // directly, so production keeps its fail-fast startup validation.)
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set");
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return ofetch<T>(url.toString(), { retry: 2, retryDelay: 500 });
});

export function tmdbFetchCached<T>(path: string, params: Record<string, string>, ttlSeconds: number): Promise<T> {
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
const TMDbGenreSchema = z.object({
  id: z.number(),
  name: z.string(),
});
const TMDbMovieDetailsSchema = z.object({
  id: z.number(),
  original_language: z.string(),
  spoken_languages: z.array(TMDbSpokenLanguageSchema),
  // Widened (Step 2 discovery→Release backfill) — these ride on the SAME
  // /movie/{id} response getCreditsAndLanguages already fetches (zero new API
  // calls). They let enrich populate the poster/synopsis/genre/popularity fields
  // that the lean discovery net deliberately doesn't carry.
  poster_path: z.string().nullable().optional(),
  overview: z.string().optional(),
  genres: z.array(TMDbGenreSchema).optional(),
  popularity: z.number().optional(),
  vote_average: z.number().optional(),
  vote_count: z.number().optional(),
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

// Release dates — for IN-region theatrical (type 2 or 3) + OTT (type 4) (Phase 5.6)
const TMDbReleaseDateEntrySchema = z.object({
  release_date: z.string(),
  type: z.number(),
});
const TMDbCountryReleaseDatesSchema = z.object({
  iso_3166_1: z.string(),
  release_dates: z.array(TMDbReleaseDateEntrySchema),
});
const TMDbReleaseDatesResponseSchema = z.object({
  id: z.number(),
  results: z.array(TMDbCountryReleaseDatesSchema),
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

/** Map a TMDb ISO 639-1 code to our Language enum ("Other" when unmapped). */
export function mapLanguage(iso: string): Language {
  return LANGUAGE_MAP[iso] ?? "Other";
}
function mapProvider(name: string): Platform | null {
  return PROVIDER_MAP[name] ?? null;
}
/** Build a w500 TMDb poster URL from a poster_path (undefined when null). */
export function posterUrl(path: string | null): string | undefined {
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
          tmdbPopularity: m.popularity,
          tmdbVoteAverage: m.vote_average,
          tmdbVoteCount: m.vote_count,
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
          tmdbPopularity: m.popularity,
          tmdbVoteAverage: m.vote_average,
          tmdbVoteCount: m.vote_count,
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
  releaseDates?: {                    // Phase 5.6
    theatrical?: string;
    ott?: string;
  };
  // Step 2 backfill — sourced from the SAME /movie/{id} response (zero new
  // calls). Populate the Release fields the lean discovery net doesn't carry.
  // The old ingest path already has these from the discover row, so enrich only
  // applies them to lean discovery stubs (gated on a missing tmdbPopularity).
  posterUrl?: string;
  synopsis?: string;
  genre?: string[];
  tmdbPopularity?: number;
  tmdbVoteAverage?: number;
  tmdbVoteCount?: number;
}

/**
 * Phase 5.5+5.6 — fetch top-2 billed cast, music composer, audio language
 * structure, and IN-region release dates from TMDb in one shot.
 *
 * Calls /movie/{id} (for spoken_languages + original_language),
 * /movie/{id}/credits (for cast.order + crew.job), and
 * /movie/{id}/release_dates (for IN-region theatrical + OTT) in parallel.
 *
 * Returns an empty leadCast on error — the caller treats this as "no
 * enrichment available" and skips rendering the affected sections.
 */
export async function getCreditsAndLanguages(tmdbId: number): Promise<CreditsAndLanguages> {
  try {
    const [movieRaw, creditsRaw, datesRaw] = await Promise.all([
      tmdbFetchCached<unknown>(`/movie/${tmdbId}`, {}, 30 * 24 * 60 * 60),
      tmdbFetchCached<unknown>(`/movie/${tmdbId}/credits`, {}, 30 * 24 * 60 * 60),
      tmdbFetchCached<unknown>(`/movie/${tmdbId}/release_dates`, {}, 30 * 24 * 60 * 60),
    ]);
    const details = TMDbMovieDetailsSchema.parse(movieRaw);
    const credits = TMDbCreditsSchema.parse(creditsRaw);
    const dates = TMDbReleaseDatesResponseSchema.parse(datesRaw);

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

    // IN-region release dates (Phase 5.6). type 2 (limited) or 3 (wide) for
    // theatrical; type 4 for OTT/digital. We accept either 2 or 3 because
    // TMDb's Indian theatrical data sometimes uses 2 even for wide releases.
    const india = dates.results.find(r => r.iso_3166_1 === "IN");
    const theatricalDate = india?.release_dates
      .find(r => r.type === 3 || r.type === 2)
      ?.release_date.slice(0, 10);
    const ottDate = india?.release_dates
      .find(r => r.type === 4)
      ?.release_date.slice(0, 10);
    const releaseDates =
      theatricalDate || ottDate
        ? {
            ...(theatricalDate ? { theatrical: theatricalDate } : {}),
            ...(ottDate ? { ott: ottDate } : {}),
          }
        : undefined;

    const result: CreditsAndLanguages = {
      leadCast,
      audioLanguages: {
        original: isoToDisplay(originalIso),
        ...(dubbedDisplay.length > 0 ? { dubbed: dubbedDisplay } : {}),
      },
    };
    if (composer) result.musicDirector = composer.name;
    if (releaseDates) result.releaseDates = releaseDates;

    // Step 2 backfill fields — from the same details response, no extra fetch.
    const poster = posterUrl(details.poster_path ?? null);
    if (poster) result.posterUrl = poster;
    if (details.overview) result.synopsis = details.overview;
    if (details.genres && details.genres.length > 0) result.genre = details.genres.map((g) => g.name);
    if (typeof details.popularity === "number") result.tmdbPopularity = details.popularity;
    if (typeof details.vote_average === "number") result.tmdbVoteAverage = details.vote_average;
    if (typeof details.vote_count === "number") result.tmdbVoteCount = details.vote_count;
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

// ─────────────────────────────────────────────────────────────────────────────
// Title search (READ-ONLY addition) — resolve an AI-net lead to a TMDb id and
// tell MOVIE from TV/series. Pure GET via tmdbFetchCached (no new key, no write,
// no mutation). Used by the reconciliation layer:
//   - a movie hit ⇒ the lead is a real film (id + canonical title + poster);
//   - a /search/tv hit with NO qualifying movie ⇒ the caller treats it as a
//     series and rejects it.
// We do NOT filter by year at the API (recall first) — the caller does the ±1yr
// disambiguation off `year`, which is what avoids the "wrong-year same-title"
// trap (e.g. 2019 Blast vs 2026 Blast). `year`/`language` here only RANK hits.
// ─────────────────────────────────────────────────────────────────────────────

const TMDbSearchMovieResultSchema = z.object({
  id: z.number(),
  title: z.string(),
  original_title: z.string().optional(),
  original_language: z.string().optional(),
  release_date: z.string().optional().default(""),
  poster_path: z.string().nullable().optional(),
});
const TMDbSearchTvResultSchema = z.object({
  id: z.number(),
  name: z.string(),
  original_name: z.string().optional(),
  original_language: z.string().optional(),
  first_air_date: z.string().optional().default(""),
  poster_path: z.string().nullable().optional(),
});
const TMDbSearchMovieResponseSchema = z.object({
  results: z.array(TMDbSearchMovieResultSchema),
});
const TMDbSearchTvResponseSchema = z.object({
  results: z.array(TMDbSearchTvResultSchema),
});

export interface TmdbTitleHit {
  id: number;
  title: string;
  releaseDate?: string;
  posterPath?: string;
  year?: number;
  originalLanguage?: string;
}
export interface TmdbTitleSearch {
  movie: TmdbTitleHit[];
  tv: TmdbTitleHit[];
}

function yearFromDate(d: string): number | undefined {
  const y = Number.parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) && y > 1900 ? y : undefined;
}

/** Rank hits: closeness to `year` first, then original_language match. */
function rankHits(hits: TmdbTitleHit[], year?: number, langIso?: string): TmdbTitleHit[] {
  return [...hits].sort((a, b) => {
    if (year !== undefined) {
      const da = a.year !== undefined ? Math.abs(a.year - year) : 999;
      const db = b.year !== undefined ? Math.abs(b.year - year) : 999;
      if (da !== db) return da - db;
    }
    if (langIso) {
      const la = a.originalLanguage === langIso ? 0 : 1;
      const lb = b.originalLanguage === langIso ? 0 : 1;
      if (la !== lb) return la - lb;
    }
    return 0;
  });
}

const NAME_TO_ISO: Record<string, string> = {
  telugu: "te", tamil: "ta", malayalam: "ml", kannada: "kn",
  hindi: "hi", bengali: "bn", marathi: "mr", punjabi: "pa",
};

/**
 * Search TMDb for a title across movies AND TV. Returns BOTH lists so the caller
 * can resolve a film id and detect that a lead is actually a series. Never throws
 * — returns empty lists on failure.
 */
export async function searchTitleTmdb(
  title: string,
  opts: { year?: number; language?: string } = {}
): Promise<TmdbTitleSearch> {
  const TTL = 7 * 24 * 60 * 60; // 7 days — search results are stable
  const langIso = opts.language ? NAME_TO_ISO[opts.language.trim().toLowerCase()] : undefined;
  try {
    const [movieRaw, tvRaw] = await Promise.all([
      tmdbFetchCached<unknown>("/search/movie", { query: title, include_adult: "false", region: "IN" }, TTL),
      tmdbFetchCached<unknown>("/search/tv", { query: title, include_adult: "false" }, TTL),
    ]);
    const movieParsed = TMDbSearchMovieResponseSchema.parse(movieRaw);
    const tvParsed = TMDbSearchTvResponseSchema.parse(tvRaw);

    const movie: TmdbTitleHit[] = movieParsed.results.map(m => {
      const y = m.release_date ? yearFromDate(m.release_date) : undefined;
      return {
        id: m.id,
        title: m.title,
        ...(m.release_date ? { releaseDate: m.release_date } : {}),
        ...(m.poster_path ? { posterPath: m.poster_path } : {}),
        ...(y !== undefined ? { year: y } : {}),
        ...(m.original_language ? { originalLanguage: m.original_language } : {}),
      };
    });
    const tv: TmdbTitleHit[] = tvParsed.results.map(t => {
      const y = t.first_air_date ? yearFromDate(t.first_air_date) : undefined;
      return {
        id: t.id,
        title: t.name,
        ...(t.first_air_date ? { releaseDate: t.first_air_date } : {}),
        ...(t.poster_path ? { posterPath: t.poster_path } : {}),
        ...(y !== undefined ? { year: y } : {}),
        ...(t.original_language ? { originalLanguage: t.original_language } : {}),
      };
    });

    return { movie: rankHits(movie, opts.year, langIso), tv: rankHits(tv, opts.year, langIso) };
  } catch (err) {
    log.warn(`searchTitleTmdb failed for "${title}"`, err instanceof Error ? err.message : err);
    return { movie: [], tv: [] };
  }
}
