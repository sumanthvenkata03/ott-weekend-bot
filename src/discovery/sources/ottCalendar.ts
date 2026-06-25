// src/discovery/sources/ottCalendar.ts
// The OTT-CALENDAR net — V3. A SECOND, fully DECOUPLED OTT discovery source
// (sibling to ottSearch.ts) that closes the gap V2 left open: Tavily only ever
// returned a SNIPPET of an editorial "this week's OTT releases" roundup page
// (the header / SEO block), so a film whose row sits in the BODY (the Blast
// case) never reached the extractor. This source fetches the FULL BODY of one
// fixed roundup page, flattens it to plaintext, and runs its OWN Claude
// extraction over the whole body — so every film the page lists is available.
//
// DECOUPLING (locked decision): this is NOT folded into ottSearch's runAiNet
// snippet pool. It fetches its own page, runs its OWN callClaudeJSON extraction,
// and caches under its OWN key. The two OTT nets stay independent — a change to
// one cannot perturb the other, and getCandidates(ott) unions both.
//
//   1. fetchCached (research/http.ts) GETs the fixed undated Filmibeat roundup
//      URL as TEXT — the full, untruncated body Tavily's snippet lacked.
//   2. node-html-parser flattens the body to plaintext (scripts/styles stripped).
//      We do NOT structured-row-parse: the body is editorial PROSE, and a brittle
//      DOM parse would silently drop films — the LLM extracts instead.
//   3. ONE cached callClaudeJSON extraction over the flattened body, same
//      films-only / series-rejected / data-only discipline as ottSearch.
//   4. Each extracted film resolves via the SHARED resolveTitleToTmdb (no clone)
//      and is emitted as a DiscoveredFilm carrying the press OTT date / platform
//      with releaseType "digital" and foundIn ["ott-calendar"].
//
// Fails SAFE and ADDITIVE: any fetch/parse/extraction failure — or a non-empty
// page that yields 0 films (the scrape-rotted tripwire) — degrades to [] with a
// LOUD warn. getCandidates(ott) is then byte-for-byte its pre-V3 result; the
// other two OTT nets are unaffected. This source can only ADD films, never
// remove them or break OTT discovery.

import { z } from "zod";
import { parse } from "node-html-parser";
import { callClaudeJSON } from "../../content/claude.js";
import { fetchCached } from "../../research/http.js";
import { cached } from "../../shared/cache.js";
import { log } from "../../shared/logger.js";
import { searchTitleTmdb, type TmdbTitleHit } from "../../ingestion/releases/tmdb.js";
import { normalizeTitle } from "../normalize.js";
import { resolveTitleToTmdb, languageForCode, INDIAN_LANG_CODES } from "./resolveTitle.js";
import type { ExtractedFilm, ExtractionResult, RejectedExtraction } from "../../reconcile/types.js";
import type { DiscoveredFilm } from "../types.js";

// The ONE fixed, undated roundup URL — always serves the CURRENT week's slate,
// so no slug construction / RSS / per-language URLs (deferred). Verified live to
// list this week's films (incl. Blast) in its body.
const FILMIBEAT_OTT_URL = "https://www.filmibeat.com/top-listing/ott-movie-releases-this-week/";
const UA = "TBSI-discovery/1.0 (editorial automation; contact webnexasolutionsllc@gmail.com)";

const FETCH_TTL = 21600;        // 6h — the roundup changes slowly within a window
const EXTRACT_TTL = 86400;      // 24h — keeps the gate hash stable across an --approve re-run
const MAX_BODY_CHARS = 40000;   // generous bound on the LLM input (a week's roundup flattens to ~16k)

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// ── Extraction schema — its OWN copy (decoupled from ottSearch). films-only,
// title/language/platform/date, series go to "rejected". `sources` is OPTIONAL
// here (a single-page body has no per-film URL — the page itself is the source,
// defaulted in downstream). ──────────────────────────────────────────────────
const ExtractedSourceSchema = z.object({
  url: z.string(),
  snippet: z.string().optional(),
});
const ExtractedFilmSchema = z.object({
  title: z.string(),
  language: z.string().optional(),
  platform: z.string().optional(),
  date: z.string().optional(),
  datesSeen: z.array(z.string()).optional(),
  isSeries: z.boolean().default(false),
  sources: z.array(ExtractedSourceSchema).default([]),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});
const RejectedSchema = z.object({
  title: z.string().optional(),
  reason: z.string(),
});
const ExtractionSchema = z.object({
  films: z.array(ExtractedFilmSchema).default([]),
  rejected: z.array(RejectedSchema).default([]),
});

/** Fetch the full roundup body as TEXT (cached, throttled, polite UA). Throws on
 *  a transient fetch error — the caller degrades to []; fetchCached never caches
 *  a thrown error, so a failed fetch is retried next run rather than poisoning. */
async function fetchBody(): Promise<string> {
  const { value } = await fetchCached<string>("discovery:ottcalendar:filmibeat", FILMIBEAT_OTT_URL, {
    ttlSeconds: FETCH_TTL,
    responseType: "text",
    headers: { "User-Agent": UA },
  });
  return value;
}

/** Flatten an HTML body to a single whitespace-collapsed plaintext string. Strips
 *  script/style/noscript/svg so JSON-LD and CSS never leak into the LLM input.
 *  Bounded to MAX_BODY_CHARS (a week's roundup is ~16k, well under). */
function flattenBody(html: string): string {
  const root = parse(html);
  for (const n of root.querySelectorAll("script,style,noscript,svg")) n.remove();
  const text = root.text.replace(/\s+/g, " ").trim();
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

function buildPrompt(from: string, to: string, body: string): string {
  return `You are a film-release extractor for The Big Screen Index. You read the full text of ONE editorial "this week's OTT releases" roundup page and extract the distinct FILMS that START STREAMING (digital release) in India in a given window. You output DATA ONLY.

#1 RULE — USE ONLY THE PAGE TEXT (this is the most important rule):
- Every film and every field MUST come from the PAGE TEXT block below. Do NOT add anything from your own knowledge or memory, even if you are certain you know this film.
- If a field is not stated in the page text, OMIT it. Never guess, infer, or estimate a title, platform, or date.
- You have no web access. The PAGE TEXT block is your ONLY ground truth.

YOU MAY OUTPUT ONLY: title, language, platform, and date. Do NOT output cast, synopsis, poster, rating, runtime, or any descriptive copy — those are sourced elsewhere, never by you.

REJECT NON-FILMS (put them in "rejected", do NOT put them in "films"):
- Reject anything that is a SERIES, SEASON, web series, anthology, TV show, reality show, or episodic show. A title described as "Season 1/2", "series", "episodes", "show", or "part of a season" is NOT a film. Set reason "series".
- Reject trailers, teasers, songs, first-looks, and anything with no actual digital release in the window. Set an appropriate reason.

WINDOW: ${from} to ${to} (inclusive), India. Edition: OTT — films that START STREAMING (digital release) in India in this window.

FOR EACH FILM:
- title: exactly as written in the page text.
- language: only if the page text states it (e.g. Tamil, Telugu, Hindi, Malayalam, Kannada).
- platform: only if stated (the OTT service for the streaming release, e.g. Netflix, Prime Video, JioHotstar).
- date: the digital/stream date if stated, as YYYY-MM-DD when possible.
- datesSeen: every distinct date the page attaches to this film.
- isSeries: normally false — series belong in "rejected".
- confidence: "high" (clearly listed with platform + date), "medium" (listed, partial detail), "low" (mentioned in passing).

PAGE TEXT (the ONLY ground truth):
${body}

OUTPUT — STRICT JSON ONLY (no markdown, no prose). Omit any field the page text doesn't support:
{
  "films": [
    { "title": "...", "language": "...", "platform": "...", "date": "YYYY-MM-DD", "datesSeen": ["YYYY-MM-DD"], "isSeries": false, "confidence": "high" }
  ],
  "rejected": [ { "title": "...", "reason": "series" } ]
}`;
}

/** ONE cached LLM extraction over the flattened body. OWN cache key (decoupled
 *  from ottSearch's). Throws propagate to the caller's degrade-to-[] path. */
async function extract(from: string, to: string, body: string): Promise<ExtractionResult> {
  const cacheKey = `reconcile:extract:ott-calendar:${from}:${to}`;
  return cached<ExtractionResult>(
    cacheKey,
    async () => {
      const parsed = await callClaudeJSON(buildPrompt(from, to, body), ExtractionSchema, "opus");
      return {
        films: parsed.films as ExtractedFilm[],
        rejected: parsed.rejected as RejectedExtraction[],
        dateConflict: [],
      };
    },
    { ttlSeconds: EXTRACT_TTL }
  );
}

function yearOf(date: string | undefined, fallback: number): number {
  if (date && ISO.test(date)) {
    const y = Number.parseInt(date.slice(0, 4), 10);
    if (Number.isFinite(y) && y > 1900) return y;
  }
  return fallback;
}

/** Build a DiscoveredFilm from a resolved calendar OTT find. The page URL is the
 *  default provenance when the extractor attached none (the body is one source). */
function toDiscoveredFilm(ai: ExtractedFilm, hit: TmdbTitleHit, windowYear: number): DiscoveredFilm {
  const language = languageForCode(hit.originalLanguage);
  const ottDate = ai.date && ISO.test(ai.date) ? ai.date : undefined;
  const year = yearOf(ottDate, hit.year ?? windowYear);
  return {
    title: hit.title,
    normalizedTitle: normalizeTitle(hit.title),
    year,
    language,
    ...(ottDate ? { releaseDate: ottDate } : {}),
    releaseType: "digital",
    tmdbId: hit.id,
    ...(ottDate ? { ottDate } : {}),
    ...(ai.platform ? { platform: ai.platform } : {}),
    sourceUrl: ai.sources?.[0]?.url ?? FILMIBEAT_OTT_URL,
    foundIn: ["ott-calendar"],
    perSource: {},
  };
}

/**
 * Discovery OTT-CALENDAR net. Fetches the full body of the fixed Filmibeat
 * roundup page, flattens it, runs ONE cached Claude extraction over the whole
 * body, resolves each film via the SHARED resolveTitleToTmdb, and emits
 * DiscoveredFilm OTT candidates (releaseType "digital", press ottDate/platform,
 * foundIn ["ott-calendar"]). Series / non-Indian / unresolved leads are dropped.
 *
 * Fails SAFE + ADDITIVE — NEVER throws:
 *  - fetch error / Cloudflare / throw → [] (degrade; fetchCached doesn't cache errors)
 *  - non-empty body but extraction yields 0 films → LOUD parse-break warn + []
 *  - extraction throws → [] (degrade)
 * In every failure path getCandidates(ott) is byte-for-byte its pre-V3 result.
 */
export async function discoverOttCalendar(
  _languages: string[],
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  let body: string;
  try {
    body = await fetchBody();
  } catch (err) {
    log.warn(
      `OTT calendar: fetch failed — degrading to [] (other OTT nets unaffected): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const text = flattenBody(body);
  if (text.length === 0) {
    log.warn(`OTT calendar: roundup body was empty after flatten — degrading to []`);
    return [];
  }

  let extraction: ExtractionResult;
  try {
    extraction = await extract(from, to, text);
  } catch (err) {
    log.error(
      `OTT calendar: extraction failed — degrading to []`,
      err instanceof Error ? err.message : err
    );
    return [];
  }

  // SILENT-BREAK TRIPWIRE — the body fetched OK (non-empty) but the extractor
  // found nothing. That is the scrape-rotted signature (page layout changed,
  // film list moved, content now JS-rendered). Alarm LOUDLY, exactly like the
  // crossNetGuard "EXISTS but parsed 0 — possible parser break" warning, so a
  // dead source is caught before it ships an empty drop. Still returns [] —
  // additive: the other OTT nets carry the window.
  if (extraction.films.length === 0) {
    log.warn(
      `⚠ COVERAGE: OTT calendar page fetched OK (${text.length} chars) but extracted 0 films — ` +
        `possible scrape/parser break (${FILMIBEAT_OTT_URL})`
    );
    return [];
  }

  const windowYear = Number.parseInt(from.slice(0, 4), 10);
  const films: DiscoveredFilm[] = [];
  for (const ai of extraction.films) {
    const search = ai.isSeries
      ? { movie: [], tv: [] }
      : await searchTitleTmdb(ai.title, { year: windowYear, ...(ai.language ? { language: ai.language } : {}) });
    const res = resolveTitleToTmdb(
      { title: ai.title, isSeries: ai.isSeries, ...(ai.language ? { language: ai.language } : {}) },
      search,
      windowYear
    );
    if (res.kind !== "movie" || !res.hit) continue;        // series / unverified — dropped
    const iso = res.hit.originalLanguage;
    if (!iso || !INDIAN_LANG_CODES.has(iso)) continue;     // non-Indian — dropped
    films.push(toDiscoveredFilm(ai, res.hit, windowYear));
  }
  log.info(`OTT calendar: ${extraction.films.length} extracted → ${films.length} resolved Indian film(s)`);
  return films;
}
