// src/ingestion/releases/omdb.ts
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { config } from "../../shared/config.js";
import { log } from "../../shared/logger.js";
import { cached } from "../../shared/cache.js";

const BASE_URL = "http://www.omdbapi.com";

// OMDb free tier: 1000 req/day. Throttle to 2 req/s as a polite buffer.
const throttle = pThrottle({ limit: 2, interval: 1000 });

const OmdbResponseSchema = z.object({
  Title: z.string().optional(),
  Year: z.string().optional(),
  Runtime: z.string().optional(),
  Genre: z.string().optional(),
  Director: z.string().optional(),
  Actors: z.string().optional(),
  Plot: z.string().optional(),
  Poster: z.string().optional(),
  imdbRating: z.string().optional(),
  imdbVotes: z.string().optional(),
  imdbID: z.string().optional(),
  Ratings: z.array(z.object({
    Source: z.string(),
    Value: z.string(),
  })).optional(),
  Response: z.union([z.string(), z.boolean()]),
  Error: z.string().optional(),
});

export interface OmdbData {
  imdbId: string;
  imdbRating?: number;
  imdbVotes?: number;
  rottenTomatoes?: number;
  metacritic?: number;
  director?: string;
  cast: string[];
  runtime?: number;
}

function parseNumberOrUndef(s: string | undefined): number | undefined {
  if (!s || s === "N/A") return undefined;
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function parseRuntime(s: string | undefined): number | undefined {
  if (!s || s === "N/A") return undefined;
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseRtScore(ratings: { Source: string; Value: string }[] | undefined): number | undefined {
  if (!ratings) return undefined;
  const rt = ratings.find(r => r.Source === "Rotten Tomatoes");
  if (!rt) return undefined;
  const m = rt.Value.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

function parseMetacritic(ratings: { Source: string; Value: string }[] | undefined): number | undefined {
  if (!ratings) return undefined;
  const mc = ratings.find(r => r.Source === "Metacritic");
  if (!mc) return undefined;
  const m = mc.Value.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

// Throttle only the actual HTTP call, so cache hits return instantly.
const throttledOfetch = throttle((imdbId: string) =>
  ofetch(BASE_URL, {
    query: { apikey: config.OMDB_API_KEY, i: imdbId, plot: "short" },
    retry: 2,
    retryDelay: 500,
  })
);

/**
 * Fetch OMDb data for a single IMDb ID.
 * Cache hits return instantly; cache misses respect the throttle.
 * Returns null if not found / no data available.
 */
export async function fetchOmdbByImdbId(imdbId: string): Promise<OmdbData | null> {
  try {
    const raw = await cached(
      `omdb:${imdbId}`,
      () => throttledOfetch(imdbId),
      { ttlSeconds: 24 * 60 * 60 }
    );
    
    const parsed = OmdbResponseSchema.parse(raw);
    
    const responseTrue = parsed.Response === "True" || parsed.Response === true;
    if (!responseTrue) {
      if (process.env.DEBUG_OMDB === "1") {
        log.info(`OMDb: no data for ${imdbId} (${parsed.Error ?? "unknown"})`);
      }
      return null;
    }
    
    return {
      imdbId,
      imdbRating: parseNumberOrUndef(parsed.imdbRating),
      imdbVotes: parseNumberOrUndef(parsed.imdbVotes),
      rottenTomatoes: parseRtScore(parsed.Ratings),
      metacritic: parseMetacritic(parsed.Ratings),
      director: parsed.Director && parsed.Director !== "N/A" ? parsed.Director : undefined,
      cast: parsed.Actors && parsed.Actors !== "N/A" 
        ? parsed.Actors.split(",").map(s => s.trim()).filter(Boolean)
        : [],
      runtime: parseRuntime(parsed.Runtime),
    };
  } catch (err) {
    log.warn(`OMDb fetch failed for ${imdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}