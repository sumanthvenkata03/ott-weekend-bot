// src/ingestion/releases/omdb.ts
import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { config } from "../../shared/config.js";
import { log } from "../../shared/logger.js";

const BASE_URL = "http://www.omdbapi.com";

// OMDb free tier: 1000 req/day. Throttle to 2 req/s as a polite buffer.
const throttle = pThrottle({ limit: 2, interval: 1000 });

// OMDb returns weird shapes — "N/A" for missing fields, ratings as strings, etc.
const OmdbResponseSchema = z.object({
  Title: z.string().optional(),
  Year: z.string().optional(),
  Runtime: z.string().optional(),       // "179 min" or "N/A"
  Genre: z.string().optional(),
  Director: z.string().optional(),
  Actors: z.string().optional(),
  Plot: z.string().optional(),
  Poster: z.string().optional(),
  imdbRating: z.string().optional(),    // "7.6" or "N/A"
  imdbVotes: z.string().optional(),     // "97,231"
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
  runtime?: number;        // minutes
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

/**
 * Fetch OMDb data for a single IMDb ID.
 * Returns null if not found / no data available.
 */
export const fetchOmdbByImdbId = throttle(async (imdbId: string): Promise<OmdbData | null> => {
  try {
    const raw = await ofetch(BASE_URL, {
      query: { apikey: config.OMDB_API_KEY, i: imdbId, plot: "short" },
      retry: 2,
      retryDelay: 500,
    });
    
    const parsed = OmdbResponseSchema.parse(raw);
    
    // OMDb returns Response="False" + Error for not-found
    const responseTrue = parsed.Response === "True" || parsed.Response === true;
   if (!responseTrue) {
      // Common for unreleased films — don't pollute logs unless explicitly debugging
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
});