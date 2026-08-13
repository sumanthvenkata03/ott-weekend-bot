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
  Language: z.string().optional(),     // Phase 5.7 — comma-separated dub list
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
  /** Phase 5.7 — raw OMDb Language field, split + trimmed.
   *  E.g. "Telugu, Tamil, Hindi" → ["Telugu", "Tamil", "Hindi"].
   *  Caller merges this with TMDb spoken_languages for the final audio list. */
  languages: string[];
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
 * Credentials that are present but obviously not real. config.ts enforces
 * `min(1)`, so an EMPTY key never reaches production — but a placeholder does,
 * and a placeholder is exactly what test/CI environments carry.
 *
 * Deliberately an exact list, not a shape heuristic: OMDb keys are 8 hex
 * characters, and a length/charset rule would reject a valid key the day OMDb
 * changes format — silently disabling ratings for everyone. A known-placeholder
 * list can only ever produce a false NEGATIVE (a weird real key still fires),
 * which is the safe direction to be wrong in.
 */
const PLACEHOLDER_KEYS = new Set([
  "test", "testing", "changeme", "change_me", "placeholder", "dummy", "fake",
  "none", "null", "undefined", "todo", "xxx", "xxxxxxxx", "your_key_here",
  "your_api_key", "api_key", "secret",
]);

/** True when the key is absent, blank, or a recognised placeholder. */
export function isPlaceholderOmdbKey(key: string | undefined): boolean {
  const k = (key ?? "").trim();
  return k.length === 0 || PLACEHOLDER_KEYS.has(k.toLowerCase());
}

/** One warn per process, mirroring MDBList's warnedNoKey. */
let warnedBadKey = false;

/** Test seam — reset the once-only warn between cases. */
export function __resetOmdbKeyWarning(): void {
  warnedBadKey = false;
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
  // ── WD-ENG-10 PART 3 — REFUSE TO FIRE WITHOUT A REAL KEY ──────────────────
  // This client was the only one that called out unconditionally. TMDb THROWS a
  // named error when its key is unset; MDBList short-circuits with a log line
  // and returns null. OMDb did neither: it handed whatever `config.OMDB_API_KEY`
  // held straight to ofetch with `retry: 2`, so a placeholder key meant three
  // doomed round-trips to a third party PER FILM, each 401, each swallowed by
  // the catch below — invisible, and for weeks it was happening on every test
  // run with the fake key "test".
  //
  // Short-circuiting here is correct regardless of tests: burning retries and
  // someone else's rate limit on a credential we can see is wrong is not
  // resilience, it is noise. Logged ONCE (like MDBList) so a misconfigured
  // environment says so plainly instead of degrading in silence.
  if (isPlaceholderOmdbKey(config.OMDB_API_KEY)) {
    if (!warnedBadKey) {
      warnedBadKey = true;
      log.warn(
        `OMDb: OMDB_API_KEY is missing or a placeholder (${JSON.stringify(config.OMDB_API_KEY ?? "")}) — ` +
        `skipping all OMDb enrichment. No request was attempted. Set a real key in .env to restore ratings/cast/language backfill.`
      );
    }
    return null;
  }

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
      languages: parsed.Language && parsed.Language !== "N/A"
        ? parsed.Language.split(",").map(s => s.trim()).filter(Boolean)
        : [],
    };
  } catch (err) {
    log.warn(`OMDb fetch failed for ${imdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}