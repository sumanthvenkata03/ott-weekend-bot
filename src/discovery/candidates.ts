// src/discovery/candidates.ts
// Step 2 — the SHARED pillar-facing candidate surface. Every drop/pillar calls
// getCandidates(window, languages, intent) instead of doing its own search, and
// gets back an ENRICHED Release[] in the exact shape today's ingest* produces
// (so reconcile / gate / AI-review consume it unchanged).
//
// Shape: approach (b) public — getCandidates does discover → adapt → enrich
// internally — over (a) internal — toReleaseStub + enrichReleases are exported
// reusable steps. Enrichment is NOT duplicated: it reuses the one shared
// enrichReleases seam in ingestion/releases/index.ts.
//
// SCOPE (Step 2 only): intent routes onto discovery's EXISTING releaseType
// tagging. We do NOT retire ingestOTTArrivals or unify the two OTT paths — that
// is Step 3. Wiki-only finds (no tmdbId / no releaseType) are out of scope here:
// they can't be TMDb-enriched or reconciled, so the intent filter naturally
// excludes them, keeping the pool TMDb-backed exactly like ingest* today.

import { discover, SUPPORTED_LANGUAGES } from "./index.js";
import { enrichReleases } from "../ingestion/releases/index.js";
import { log } from "../shared/logger.js";
import type { DiscoveredFilm } from "./types.js";
import type { Language, Release } from "../shared/types.js";

/** Which release a pillar wants. Single-valued — a both-pillar (Wednesday) calls
 *  twice, once per window, exactly as it does today. */
export type DropIntent = "theatrical" | "ott";

export interface CandidateQuery {
  /** Inclusive ISO yyyy-mm-dd window bounds. */
  from: string;
  to: string;
  intent: DropIntent;
  /** Human language names; defaults to all 8 supported (preserves pillar behavior). */
  languages?: string[];
}

// Runtime whitelist of the Language enum values a discovered film may carry.
// "Other" is intentionally EXCLUDED: a film discovery tagged with a language we
// don't model is dropped, never coerced to a wrong one. Keep in sync with the
// Language type in shared/types.ts.
const VALID_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "Hindi", "Telugu", "Tamil", "Malayalam", "Kannada", "Marathi", "Bengali", "Punjabi",
]);

/** Map a discovery language STRING to the Language enum; undefined if unrecognized. */
function toLanguageEnum(s: string | undefined): Language | undefined {
  return s !== undefined && VALID_LANGUAGES.has(s as Language) ? (s as Language) : undefined;
}

/**
 * Adapt a discovery find into a Release STUB — identity + date + provenance the
 * enrichment chain needs, with no fabricated content fields (those get filled by
 * enrichReleases). The language string is mapped to the Language enum; an
 * UNRECOGNIZED language returns `undefined` so getCandidates DROPS the film
 * (decision: drop + warn — never coerce a stray TMDb tag to a wrong language,
 * never crash). The empty content fields (genre/synopsis/posterUrl/popularity)
 * are exactly what the Step 2 /movie/{id} backfill fills during enrich.
 */
export function toReleaseStub(f: DiscoveredFilm): Release | undefined {
  const language = toLanguageEnum(f.language);
  if (!language) {
    log.warn(`getCandidates: dropping "${f.title}" — unrecognized language "${f.language ?? ""}"`);
    return undefined;
  }
  return {
    id: f.tmdbId !== undefined ? `tmdb-${f.tmdbId}` : `disc-${f.normalizedTitle}`,
    ...(f.tmdbId !== undefined ? { tmdbId: f.tmdbId } : {}),
    title: f.title,
    language,
    isSeries: false,
    platform: [],
    releaseDate: f.releaseDate ?? "",
    genre: [],
    cast: [],
    synopsis: "",
    subtitleLanguages: [],
    // tmdbPopularity deliberately omitted — its absence is the signal enrich
    // uses to know this is a lean stub that needs the /movie/{id} backfill.
    sources: ["tmdb"],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Does a discovery find match the requested intent? Routes onto discovery's
 * existing releaseType tagging (set by the TMDb net's theatrical + digital
 * passes). Wiki-only finds carry no releaseType and are excluded from BOTH
 * intents (Step 2 keeps the pool TMDb-backed; see file header).
 */
function matchesIntent(f: DiscoveredFilm, intent: DropIntent): boolean {
  const rt = f.releaseType;
  if (rt === undefined) return false;
  return intent === "ott"
    ? rt === "digital" || rt === "both"
    : rt === "theatrical" || rt === "both";
}

/**
 * The shared candidate surface. Discover films in [from,to] for the languages,
 * keep those matching the intent (theatrical vs OTT), adapt each to a Release
 * stub, and run the shared enrichment seam. Returns enriched Release[] in the
 * same shape ingest* produces — every emitted film carries a tmdbId, so the
 * §6 must-match fields (tmdbId, tmdbPopularity, releaseDate, releaseDates,
 * platform[], language enum, title, sources[], imdbId) all populate.
 */
export async function getCandidates(q: CandidateQuery): Promise<Release[]> {
  const languages = q.languages && q.languages.length > 0 ? q.languages : SUPPORTED_LANGUAGES;
  const result = await discover({ from: q.from, to: q.to, languages });

  const stubs = result.films
    .filter((f) => matchesIntent(f, q.intent))
    .map(toReleaseStub)
    .filter((r): r is Release => r !== undefined);

  log.info(`getCandidates [${q.intent}]: ${stubs.length} candidate(s) → enriching`);
  return enrichReleases(stubs);
}
