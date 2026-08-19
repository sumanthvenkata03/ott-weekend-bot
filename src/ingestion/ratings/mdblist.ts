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

// MDBList returns a `ratings` array of { source, value, score, votes, url, ... }.
// value may be null (source tracked but no score).
//
// ── WD-046-SEAL-B — `votes` IS NOW READ ────────────────────────────────────
// This schema used to take source + value only, and zod stripped everything
// else at parse time. The cost was invisible: MDBList mirrors IMDb's VOTE COUNT
// on every rating row, and dropping it left Release.imdbVotes unset for every
// film MDBList covered — so hasRealVoteBase (the ENG-10 seal floor) could only
// ever be satisfied by TMDb's own count, which for new Indian releases sits at
// 0–25 against a floor of 50. Every Wed Drop card therefore printed NEW,
// including films with tens of thousands of real IMDb ballots behind them
// (Welcome to the Jungle: 20,824 votes; Jana Nayagan: 5,158).
//
// OMDb was already the vote source, but it answers "N/A" for these titles —
// verified across the whole deck — so MDBList is not a second opinion here, it
// is the only one. It stays STRICTLY a fill-absent source behind OMDb.
const MdblistResponseSchema = z.object({
  ratings: z
    .array(
      z.object({
        source: z.string(),
        value: z.number().nullable(),
        // Accepts a bare number (what the API sends today) OR a formatted string,
        // so a provider-side change to "20,824" cannot silently zero the count.
        // Absent/null is normal and stays absent — never coerced to 0.
        votes: z.union([z.number(), z.string()]).nullish(),
      })
    )
    .nullish(),
});

/**
 * Normalize a vote count from whatever MDBList sent. Exported so the tolerance
 * is pinned directly rather than inferred from a fixture.
 *
 * Returns undefined — never 0 — for anything unusable, because 0 and "unknown"
 * mean different things to hasRealVoteBase: 0 is a real claim that nobody voted,
 * undefined is the absence of evidence. Fabricating the former from the latter
 * is exactly what the seal floor exists to prevent.
 */
export function parseVoteCount(v: unknown): number | undefined {
  if (typeof v === "number") {
    return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
  }
  if (typeof v === "string") {
    // Thousands separators (",", spaces, thin spaces) and stray whitespace only.
    const n = Number.parseFloat(v.replace(/[,\s  ]/g, ""));
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
  }
  return undefined;
}

/** Normalized MDBList ratings. Scales: imdb 0–10, rtCritic/rtAudience/metacritic
 *  0–100, letterboxd 0–5. All optional — a source is present only if MDBList
 *  returned a non-null value for it. */
export interface MdblistRatings {
  imdb?: number;        // source "imdb"        (0–10)
  rtCritic?: number;    // source "tomatoes"    (0–100, RT critic %)
  rtAudience?: number;  // source "popcorn"     (0–100, RT audience %)
  metacritic?: number;  // source "metacritic"  (0–100)
  letterboxd?: number;  // source "letterboxd"  (0–5)
  /**
   * WD-046-SEAL-B — ballots behind the IMDb rating, mirrored by MDBList.
   * Captured ONLY alongside a present `imdb` value: a count with no rating under
   * it would back a score IMDb never gave, which is not what the seal claims.
   */
  imdbVotes?: number;
}

function mapRatings(
  ratings: Array<{ source: string; value: number | null; votes?: unknown }>
): MdblistRatings {
  const out: MdblistRatings = {};
  for (const r of ratings) {
    if (r.value === null) continue;
    switch (r.source) {
      case "imdb": {
        out.imdb = r.value;
        // Same branch as the value on purpose — see MdblistRatings.imdbVotes.
        const votes = parseVoteCount(r.votes);
        if (votes !== undefined) out.imdbVotes = votes;
        break;
      }
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
 * HTTP status out of a thrown error, or undefined when there isn't one.
 *
 * ofetch's FetchError has carried the status on different properties across
 * versions (`status`, `statusCode`, and `response.status`), so all three are
 * consulted rather than betting on one. undefined is the meaningful answer for a
 * NETWORK-level failure (DNS, connection refused, timeout) and for a ZodError —
 * neither has a status, and both must stay loud.
 */
function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [e.status, e.statusCode, e.response?.status]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

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
    // WD-ENG-13 — A 404 IS NOT A FAULT. MDBList simply does not carry every
    // IMDb id, and for a slate of new Indian releases it carries rather few:
    // one captured Monday run logged five of these in a single pass, every one
    // of them normal. Printed as a warn they were indistinguishable from a real
    // outage — the same cry-wolf shape WD-ENG-05 found on the coverage warn, and
    // the reason an operator learns to skim past MDBList lines entirely.
    //
    // ONLY 404 is demoted. Any other status (401/403 = credential, 429 = rate
    // limit, 5xx = outage) and any NETWORK-level failure — where no status
    // exists at all — stay warns, because each is something an operator can and
    // should act on. A ZodError from the schema parse above also lands here with
    // no status, and stays loud: a shape change is exactly the silent break the
    // warn is for.
    const status = httpStatusOf(err);
    if (status === 404) {
      log.info(
        `MDBList: no entry for ${imdbId} — expected miss, not an outage (OMDb carries the fallback)`
      );
      return null;
    }
    log.warn(
      `MDBList fetch failed for ${imdbId}${status === undefined ? "" : ` (HTTP ${status})`}`,
      err instanceof Error ? err.message : err
    );
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
