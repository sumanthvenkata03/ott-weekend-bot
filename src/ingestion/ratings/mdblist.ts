// src/ingestion/ratings/mdblist.ts
// MDBList ratings client — a richer multi-source ratings layer keyed off the
// IMDb ID. Mirrors the OMDb client house style: cached, throttled, zod-parsed,
// returns null on any miss/error, NEVER throws. Optional: if MDBLIST_API_KEY is
// unset it returns null immediately (logged once) so the pipeline falls back to
// OMDb with no break.

import { ofetch } from "ofetch";
import pThrottle from "p-throttle";
import { z } from "zod";
import { config } from "../../shared/config.js";
import { log } from "../../shared/logger.js";
import { cached } from "../../shared/cache.js";
import type { Release } from "../../shared/types.js";

const BASE_URL = "https://api.mdblist.com";

// Be a polite client — same 2 req/s buffer as OMDb.
const throttle = pThrottle({ limit: 2, interval: 1000 });

// MDBList returns a `ratings` array of { source, value, ... }. value may be null
// (source tracked but no score). We only read source + value; zod strips the rest.
const MdblistResponseSchema = z.object({
  ratings: z
    .array(
      z.object({
        source: z.string(),
        value: z.number().nullable(),
      })
    )
    .nullish(),
});

/** Normalized MDBList ratings. Scales: imdb 0–10, rtCritic/rtAudience/metacritic
 *  0–100, letterboxd 0–5. All optional — a source is present only if MDBList
 *  returned a non-null value for it. */
export interface MdblistRatings {
  imdb?: number;        // source "imdb"        (0–10)
  rtCritic?: number;    // source "tomatoes"    (0–100, RT critic %)
  rtAudience?: number;  // source "popcorn"     (0–100, RT audience %)
  metacritic?: number;  // source "metacritic"  (0–100)
  letterboxd?: number;  // source "letterboxd"  (0–5)
}

function mapRatings(ratings: Array<{ source: string; value: number | null }>): MdblistRatings {
  const out: MdblistRatings = {};
  for (const r of ratings) {
    if (r.value === null) continue;
    switch (r.source) {
      case "imdb":       out.imdb = r.value; break;
      case "tomatoes":   out.rtCritic = r.value; break;
      case "popcorn":    out.rtAudience = r.value; break;
      case "metacritic": out.metacritic = r.value; break;
      case "letterboxd": out.letterboxd = r.value; break;
    }
  }
  return out;
}

// Throttle only the HTTP call so cache hits return instantly.
const throttledOfetch = throttle((imdbId: string) =>
  ofetch(`${BASE_URL}/imdb/movie/${imdbId}`, {
    query: { apikey: config.MDBLIST_API_KEY },
    retry: 2,
    retryDelay: 500,
  })
);

let warnedNoKey = false;

/**
 * Fetch MDBList ratings for a single IMDb ID.
 * - No MDBLIST_API_KEY → null immediately (logged once); OMDb fallback handles it.
 * - Cache hits return instantly; misses respect the throttle.
 * - Returns null on any miss/error/empty — NEVER throws.
 */
export async function getMdblistRatings(imdbId: string): Promise<MdblistRatings | null> {
  if (!config.MDBLIST_API_KEY) {
    if (!warnedNoKey) {
      log.info("MDBLIST_API_KEY not set — skipping MDBList ratings (OMDb fallback in use)");
      warnedNoKey = true;
    }
    return null;
  }

  try {
    const raw = await cached(
      `mdblist:${imdbId}`,
      () => throttledOfetch(imdbId),
      { ttlSeconds: 24 * 60 * 60 }
    );

    const parsed = MdblistResponseSchema.parse(raw);
    if (!parsed.ratings || parsed.ratings.length === 0) return null;

    const mapped = mapRatings(parsed.ratings);
    return Object.keys(mapped).length > 0 ? mapped : null;
  } catch (err) {
    log.warn(`MDBList fetch failed for ${imdbId}`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── TBSI Score (coverage-aware composite) ──────────────────────────────────
// Blended sources (TUNABLE): the AVERAGE-RATING magnitudes ONLY — imdb,
// metacritic, letterboxd. RT critic (rottenTomatoes) and RT audience are
// "% of critics/audience positive" CONSENSUS metrics, not quality magnitudes
// (a 95% Tomatometer ≠ 9.5/10), so averaging them with magnitude ratings would
// compare different constructs. They are kept as displayed data on the stamp but
// EXCLUDED from the blend. Coverage-aware: the mean of whatever blended sources
// are AVAILABLE, with the contributing source count tracked so the UI can show
// confidence.
export const TBSI_INCLUDED_SOURCES = ["imdb", "metacritic", "letterboxd"] as const;

/**
 * Merge ratings with MDBList PRIMARY, OMDb filling gaps, and any existing value
 * as the last resort. (Return type is inferred — its fields are number|undefined,
 * which flows cleanly into computeTbsiScore and the conditional spreads.)
 */
export function mergeRatings(
  existing: Pick<Release, "imdbRating" | "rottenTomatoes" | "rtAudience" | "metacritic" | "letterboxd">,
  omdb: { imdbRating?: number; rottenTomatoes?: number; metacritic?: number } | null,
  mdblist: MdblistRatings | null
) {
  return {
    imdbRating:     mdblist?.imdb       ?? omdb?.imdbRating     ?? existing.imdbRating,
    rottenTomatoes: mdblist?.rtCritic   ?? omdb?.rottenTomatoes ?? existing.rottenTomatoes,
    rtAudience:     mdblist?.rtAudience ?? existing.rtAudience,   // OMDb has no audience score
    metacritic:     mdblist?.metacritic ?? omdb?.metacritic     ?? existing.metacritic,
    letterboxd:     mdblist?.letterboxd ?? existing.letterboxd,   // OMDb has no Letterboxd score
  };
}

/**
 * Compute the coverage-aware TBSI Score from already-merged ratings. Blends ONLY
 * the average-rating magnitudes — imdb (0–10 as-is), metacritic/10, letterboxd*2
 * — normalized to 0–10, averaged, rounded to 1 decimal, with a count of how many
 * contributed. RT critic % is accepted (so callers can pass the full merged
 * object) but deliberately NOT blended; RT audience isn't even a parameter. See
 * the header comment for why % positive consensus metrics are excluded.
 * 0 blended sources → both undefined.
 */
export function computeTbsiScore(r: {
  // `| undefined` so callers can pass merged `number | undefined` locals directly
  // under exactOptionalPropertyTypes.
  imdbRating?: number | undefined;      // 0–10  (blended, as-is)
  rottenTomatoes?: number | undefined;  // RT critic %, 0–100 — received but NOT blended
  metacritic?: number | undefined;      // 0–100 (blended, /10)
  letterboxd?: number | undefined;      // 0–5   (blended, *2)
}): { tbsiScore?: number; tbsiSourceCount?: number } {
  const normalized: number[] = [];
  if (typeof r.imdbRating === "number") normalized.push(r.imdbRating);       // already 0–10
  if (typeof r.metacritic === "number") normalized.push(r.metacritic / 10);  // 0–100 → 0–10
  if (typeof r.letterboxd === "number") normalized.push(r.letterboxd * 2);   // 0–5  → 0–10
  // rottenTomatoes (RT critic %) intentionally NOT pushed — % positive, not a magnitude.

  if (normalized.length === 0) return {};
  const mean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
  return { tbsiScore: Math.round(mean * 10) / 10, tbsiSourceCount: normalized.length };
}
