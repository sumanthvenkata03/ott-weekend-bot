// src/discovery/candidates.ts
// The SHARED pillar-facing candidate surface. Every drop/pillar calls
// getCandidates(window, languages, intent) instead of doing its own search, and
// gets back an ENRICHED Release[] in the exact shape today's ingest* produces
// (so reconcile / gate / AI-review consume it unchanged).
//
// Shape: approach (b) public — getCandidates does discover → adapt → enrich
// internally — over (a) internal — toReleaseStub + enrichReleases are exported
// reusable steps. Enrichment is NOT duplicated: it reuses the one shared
// enrichReleases seam in ingestion/releases/index.ts.
//
// Step 3 — intent:"ott" ALSO runs discovery's AI-search OTT net (ottSearch.ts),
// so press-confirmed OTT releases TMDb's release_type=4 net misses (the Blast
// case) are found, resolved to a real tmdbId, and carry their press OTT date
// through to Release.releaseDates.ott. intent:"theatrical" does NOT trigger the
// OTT search — that is what keeps the 4 theatrical-only pillars LLM-free.

import { discover, SUPPORTED_LANGUAGES, unionFilms } from "./index.js";
import { discoverOttSearch } from "./sources/ottSearch.js";
import { discoverOttCalendar } from "./sources/ottCalendar.js";
import { enrichReleases } from "../ingestion/releases/index.js";
import { log } from "../shared/logger.js";
import { toPlatform } from "../shared/platform.js";
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
  /** Human language names; defaults to all 7 supported (preserves pillar behavior). */
  languages?: string[];
}

// Runtime whitelist of the Language enum values a discovered film may carry.
// "Other" is intentionally EXCLUDED: a film discovery tagged with a language we
// don't model is dropped, never coerced to a wrong one. Keep in sync with the
// Language type in shared/types.ts.
const VALID_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  "Hindi", "Telugu", "Tamil", "Malayalam", "Kannada", "Marathi", "Punjabi",
]);

/** Map a discovery language STRING to the Language enum; undefined if unrecognized. */
function toLanguageEnum(s: string | undefined): Language | undefined {
  return s !== undefined && VALID_LANGUAGES.has(s as Language) ? (s as Language) : undefined;
}

// Press platform name → Platform enum now lives in shared/platform.ts (toPlatform),
// reused verbatim by the reconcile core so both press-ingest paths normalize the
// same way. Unknown names still map to undefined → platform stays [].

/**
 * Adapt a discovery find into a Release STUB — identity + date + provenance the
 * enrichment chain needs, with no fabricated content fields (those get filled by
 * enrichReleases). The language string is mapped to the Language enum; an
 * UNRECOGNIZED language returns `undefined` so getCandidates DROPS the film
 * (decision: drop + warn — never coerce a stray TMDb tag to a wrong language,
 * never crash).
 *
 * Step 3 carry-through: an AI-OTT find's press ottDate → releaseDates.ott (where
 * post-validator's qualifyingDate(dateField:"ott") reads it) and its platform →
 * platform[]. The releaseDates merge in enrichWithCreditsAndLanguages keeps that
 * ott date alive when TMDb only returns a theatrical date.
 */
export function toReleaseStub(f: DiscoveredFilm): Release | undefined {
  const language = toLanguageEnum(f.language);
  if (!language) {
    log.warn(`getCandidates: dropping "${f.title}" — unrecognized language "${f.language ?? ""}"`);
    return undefined;
  }
  const platform = toPlatform(f.platform);
  return {
    id: f.tmdbId !== undefined ? `tmdb-${f.tmdbId}` : `disc-${f.normalizedTitle}`,
    ...(f.tmdbId !== undefined ? { tmdbId: f.tmdbId } : {}),
    title: f.title,
    language,
    isSeries: false,
    platform: platform ? [platform] : [],
    releaseDate: f.releaseDate ?? "",
    // Press OTT date lands here so the landing verifier (dateField:"ott") sees it.
    ...(f.ottDate ? { releaseDates: { ott: f.ottDate } } : {}),
    genre: [],
    cast: [],
    synopsis: "",
    subtitleLanguages: [],
    // tmdbPopularity deliberately omitted — its absence is the signal enrich
    // uses to know this is a lean stub that needs the /movie/{id} backfill.
    // Provenance reflects which net(s) found it (e.g. "tmdb", "ai-ott", or both).
    sources: [...f.foundIn],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Does a discovery find match the requested intent? Routes onto discovery's
 * releaseType tagging. Wiki-only finds carry no releaseType and are excluded
 * from both intents (the pool stays TMDb/AI-backed). AI-OTT finds are tagged
 * releaseType:"digital", so they match the "ott" intent.
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
 * keep those matching the intent; for OTT, ALSO run the AI-search net and union
 * its finds (deduped by tmdbId). Adapt each to a Release stub and run the shared
 * enrichment seam. Returns enriched Release[] in the same shape ingest* produces.
 */
export async function getCandidates(q: CandidateQuery): Promise<Release[]> {
  const languages = q.languages && q.languages.length > 0 ? q.languages : SUPPORTED_LANGUAGES;
  const result = await discover({ from: q.from, to: q.to, languages });

  let films = result.films.filter((f) => matchesIntent(f, q.intent));

  // OTT intent ALSO runs the two OTT recall nets (Blast-recall). Theatrical
  // intent does NOT — that intent-gate keeps the 4 theatrical-only pillars at 0
  // LLM calls. Both nets are DECOUPLED (own fetch + own extraction): the
  // AI-search net (Tavily snippets) and the OTT-calendar net (full roundup-page
  // body). unionFilms dedups by tmdbId, so a film found by any combination of
  // the TMDb digital pass, the AI net, and the calendar net collapses to ONE on
  // its shared id (no double-count); the possibleDistinct guard still fires only
  // on DIFFERENT ids, so genuine same-title namesakes stay split. A net that
  // returns [] (degraded/fail-safe) leaves the union byte-for-byte unchanged.
  if (q.intent === "ott") {
    const [ottFinds, calendarFinds] = await Promise.all([
      discoverOttSearch(languages, q.from, q.to),
      discoverOttCalendar(languages, q.from, q.to),
    ]);
    if (ottFinds.length > 0 || calendarFinds.length > 0) {
      films = unionFilms([...films, ...ottFinds, ...calendarFinds]);
    }
  }

  const stubs = films
    .map(toReleaseStub)
    .filter((r): r is Release => r !== undefined);

  log.info(`getCandidates [${q.intent}]: ${stubs.length} candidate(s) → enriching`);
  return enrichReleases(stubs);
}
