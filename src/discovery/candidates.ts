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
import { resolveWikiOnlyFilms, type WikiResolveDeps } from "./sources/resolveWikiFilm.js";
import { discoverOttSearch } from "./sources/ottSearch.js";
import { discoverOttCalendar } from "./sources/ottCalendar.js";
import { discoverNewsNet } from "./sources/newsNet.js";
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
/**
 * WD-ENG-07 — getCandidates now returns the wiki LANGUAGE INDEX alongside the
 * releases. The index is built from list pages this call already fetched and
 * parsed, so exposing it costs nothing; reconcile consumes it to answer
 * "is this Indian" and to name a language TMDb left as the "Other" placeholder.
 *
 * The return shape widened from Release[] to an object deliberately: an out-
 * param or a parallel entry point would have left two ways to call the same
 * seam, which is how a caller ends up silently on the one without the index.
 */
export interface CandidateResult {
  releases: Release[];
  /** normalizedTitle → pillar language, whole-year (see wikiLanguageIndex.ts). */
  wikiLanguageIndex: ReadonlyMap<string, string>;
}

export async function getCandidates(
  q: CandidateQuery,
  deps?: Partial<WikiResolveDeps>
): Promise<CandidateResult> {
  const languages = q.languages && q.languages.length > 0 ? q.languages : SUPPORTED_LANGUAGES;
  const result = await discover({ from: q.from, to: q.to, languages });

  // ── WD-ENG-07 — RESOLVE WIKI-ONLY FINDS BEFORE THE INTENT FILTER ─────────
  // discover() links a wiki film to TMDb only if the TMDb discover sweep found
  // the same title independently; it never SEARCHES for one. Agadha proved the
  // cost of that: a real TMDb record (1747034), one plain search away, that no
  // query was ever made for. Resolution runs here — after the union, before
  // matchesIntent — so a newly TMDb-backed film flows through the EXISTING
  // intents untouched. matchesIntent itself is deliberately unchanged: this
  // makes films TMDb-backed, it does not admit TMDb-less ones.
  // The default search is imported LAZILY, inside the call. A module-level
  // import would bind searchTitleTmdb at load time, which breaks every test that
  // partially mocks ingestion/releases/tmdb.js — and none of those tests have a
  // wiki-only film to resolve, so they must never reach this code at all.
  await resolveWikiOnlyFilms(result.films, {
    searchTitle:
      deps?.searchTitle ??
      (async (title, opts) => (await import("../ingestion/releases/tmdb.js")).searchTitleTmdb(title, opts)),
  });

  let films = result.films.filter((f) => matchesIntent(f, q.intent));

  // ── WD-ENG-05 — THE ACTUAL SILENT LOSS ────────────────────────────────────
  // Panchali Panchabhartruka was read off the Telugu 2026 list correctly (day
  // cell 14 → 2026-08-14, inside the window) and still never became a candidate.
  // It did not vanish in the parser; it was dropped HERE, by matchesIntent,
  // because a wiki-only find carries no releaseType — the documented, deliberate
  // "pool stays TMDb/AI-backed" rule three lines above.
  //
  // The rule is unchanged. What changes is that it now leaves a trace: a
  // discovery the pipeline deliberately declines is stated, so the next person
  // asking "where did that film go?" reads the answer instead of re-deriving it
  // from the HTML. VISIBILITY ONLY — no film enters or leaves the pool here.
  const wikiOnly = result.films.filter((f) => f.releaseType === undefined);
  if (wikiOnly.length > 0) {
    log.info(
      `  [${q.intent}] ${wikiOnly.length} wiki-only find(s) not carried into candidates ` +
        `(no TMDb match ⇒ no releaseType; pool stays TMDb/AI-backed): ` +
        wikiOnly.map((f) => `${f.title} (${f.language}${f.releaseDate ? `, ${f.releaseDate}` : ""})`).join("; ")
    );
  }

  // OTT intent ALSO runs the two OTT recall nets (Blast-recall). Theatrical
  // intent does NOT — that intent-gate keeps the 4 theatrical-only pillars at 0
  // LLM calls. Both nets are DECOUPLED (own fetch + own extraction): the
  // AI-search net (Tavily snippets) and the OTT-calendar net (full roundup-page
  // body). unionFilms dedups by tmdbId, so a film found by any combination of
  // the TMDb digital pass, the AI net, and the calendar net collapses to ONE on
  // its shared id (no double-count); the possibleDistinct guard still fires only
  // on DIFFERENT ids, so genuine same-title namesakes stay split. A net that
  // returns [] (degraded/fail-safe) leaves the union byte-for-byte unchanged.
  // ── WD-ENG-17 / 17D — THE THREE RECALL NETS, OTT INTENT ONLY ──────────────
  // The news net (WD-ENG-17) sits here, alongside the two OTT nets, and NOT on
  // the theatrical intent. It shipped on both intents and WD-ENG-17D moved it,
  // on measurement rather than principle.
  //
  // WHY THEATRICAL WAS DROPPED (measured, WD-ENG-17C — one billed extraction
  // over 178 real captured headlines):
  //   · 4 films extracted, 2 dated, 2 candidates — BOTH already green via TMDb.
  //     Zero new films.
  //   · One of the two carried a WRONG DATE: Batwara 1947 dated 2026-08-14 off a
  //     roundup headline that shared Awarapan 2's date; its real date is 08-13.
  //   · The two films the theatrical wiring was ADDED for — Chargesheet 03-08 and
  //     Panchali Panchabhartruka — were both correctly REJECTED, as
  //     "box office, already released" and "pre-release event, no theatrical
  //     date". Their only headlines are a box-office collection story and a
  //     pre-release event.
  //
  // THE STRUCTURAL REASON, which is why no prompt change fixes it: theatrical
  // coverage in the Indian film press is box-office and event reporting, not
  // dated release announcements. An honest extractor has nothing dateable to
  // work with, and loosening the date rule to catch these would reintroduce
  // exactly the manufactured-date failure the net exists to avoid.
  //
  // So theatrical keeps its TWO nets (TMDb + Wikipedia) and its ZERO LLM calls —
  // Mon Movement, Sat Verdict, Sun Spotlight and Fri Archives stay free. The OTT
  // half is unaffected and keeps performing (WD-ENG-17B: 6 candidates, zero
  // false positives, Mr. Work From Home recovered).
  if (q.intent === "ott") {
    const [ottFinds, calendarFinds, newsFinds] = await Promise.all([
      discoverOttSearch(languages, q.from, q.to),
      discoverOttCalendar(languages, q.from, q.to),
      discoverNewsNet(q.intent, q.from, q.to),
    ]);
    // Additive and fail-safe on the same terms as every other net: a degraded run
    // returns [] and leaves the union byte-for-byte unchanged. unionFilms dedups
    // on the shared key, so a film also found by TMDb collapses onto one record
    // and simply gains "news" in its foundIn — which is what makes it count as
    // corroboration rather than a duplicate.
    if (ottFinds.length > 0 || calendarFinds.length > 0 || newsFinds.length > 0) {
      films = unionFilms([...films, ...ottFinds, ...calendarFinds, ...newsFinds]);
    }
  }

  const stubs = films
    .map(toReleaseStub)
    .filter((r): r is Release => r !== undefined);

  log.info(`getCandidates [${q.intent}]: ${stubs.length} candidate(s) → enriching`);
  return { releases: await enrichReleases(stubs), wikiLanguageIndex: result.wikiLanguageIndex };
}
