// src/discovery/sources/newsNet.ts
// THE NEWS NET — Google News RSS as a discovery source.
//
// ── WHY THIS EXISTS (WD-ENG-15 → WD-ENG-17) ─────────────────────────────────
// The WD-ENG-15 source survey probed the whole candidate space with the project
// UA. Google News RSS was the ONLY source that carried all five of the week's
// missed films — Mr. Work From Home, Nijame Rujuvainadhi, Kattalan,
// Chargesheet 03-08 and Panchali Panchabhartruka. Four of those five have NO
// TMDb record at all; two appear in no structured feed anywhere.
//
// It was already in this codebase — as the NEWS DESK's transport
// (content/news/news-gather.ts), never wired to discovery. The gap was wiring,
// not sourcing. It is free, keyless, quota-free, and the least likely of any
// surveyed source to start 403-ing the project UA (BookMyShow, Letterboxd and
// Filmibeat all do).
//
// ── WHAT IS REUSED, NOT REBUILT ─────────────────────────────────────────────
//   fetchCached            (research/http.ts)      — cached RSS transport
//   parseNewsFeed          (news-gather.ts)        — the RSS → items parser
//   stripOutletSuffix      (news-gather.ts)        — " - Outlet" removal
//   callClaudeJSON + cached                        — the ottSearch/ottCalendar
//                                                    extraction pattern, verbatim
//   resolveTitleToTmdb, INDIAN_LANG_CODES          — the shared resolver
//   recordSourceFailure/Success                    — the WD-ENG-13 streak counter
//
// A SEPARATE MODULE, not an extension of news-gather, on purpose: the news desk
// answers "what happened", this answers "what releases in this window". They
// differ in query shape, in window semantics (publication recency vs release
// date) and in output type (NewsItem vs DiscoveredFilm). Extending the desk
// would couple an editorial pipeline to discovery and put its byte-for-byte
// behaviour at risk for no gain.
//
// ── COST PER RUN ────────────────────────────────────────────────────────────
// ONE RSS request per language (7) plus TWO window-date-anchored queries = 9
// requests, all free and cached 6h. Plus exactly ONE Claude extraction over the
// deduped headline list, cached 24h — the same one-call-per-window discipline
// ottCalendar uses. This cannot become a quota problem.
import { z } from "zod";
import { callClaudeJSON } from "../../content/claude.js";
import { fetchCached } from "../../research/http.js";
import { cached } from "../../shared/cache.js";
import { log } from "../../shared/logger.js";
import { parseNewsFeed } from "../../content/news/news-gather.js";
import { searchTitleTmdb } from "../../ingestion/releases/tmdb.js";
import { normalizeTitle } from "../normalize.js";
import { resolveTitleToTmdb, languageForCode, INDIAN_LANG_CODES } from "./resolveTitle.js";
import {
  recordSourceFailure,
  recordSourceSuccess,
  degradationLine,
  recoveryLine,
} from "./source-health.js";
import type { ExtractedFilm, ExtractionResult, RejectedExtraction } from "../../reconcile/types.js";
import type { DiscoveredFilm } from "../types.js";
import type { Language } from "../../shared/types.js";

const SOURCE_KEY = "news-net";
const SOURCE_LABEL = "News net";

const FEED_TTL = 21600; // 6h — headlines within one window move slowly
const EXTRACT_TTL = 86400; // 24h — keeps the gate hash stable across --approve
const MAX_HEADLINES = 400; // generous bound on the LLM input
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The seven pillar languages, as elsewhere in discovery. */
const LANGUAGES: Language[] = [
  "Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi",
];

export type NewsIntent = "ott" | "theatrical";

/**
 * THE DISCOVERY QUERY SET — release-calendar-shaped, NOT news-shaped.
 *
 * The news desk's seven queries ("Telugu cinema Tollywood film news OTT
 * release") are tuned for stories. WD-ENG-17 probed both shapes live against the
 * five known misses: the per-language release queries below found 3 of 5, and
 * the two WINDOW-DATE-ANCHORED queries found the remaining two — Chargesheet
 * 03-08 (Kannada theatrical, in no structured source at all) and Nijame
 * Rujuvainadhi (an ETV Win mini-film that appears only inside a prose roundup).
 * Both shapes are therefore required; neither alone is sufficient.
 */
export function buildNewsQueries(
  intent: NewsIntent,
  from: string,
  to: string
): Array<{ language?: Language; query: string }> {
  const perLanguage = LANGUAGES.map((language) => ({
    language,
    query:
      intent === "ott"
        ? `${language} OTT release this week streaming premiere`
        : `${language} movie theatrical release this week in cinemas`,
  }));

  // Date anchors, derived from the window rather than hardcoded. These are what
  // caught the two films the per-language set missed.
  const anchors = [from, to].filter((d, i, a) => ISO.test(d) && a.indexOf(d) === i);
  const dated = anchors.map((d) => ({
    query:
      intent === "ott"
        ? `South Indian OTT releases ${humanDate(d)}`
        : `new movie release ${humanDate(d)} India`,
  }));

  return [...perLanguage, ...dated];
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-08-14" → "August 14 2026". Google News reads prose dates, not ISO. */
export function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => Number.parseInt(n, 10));
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${MONTHS[m - 1]} ${d} ${y}`;
}

/** Google News RSS search URL. `when:7d` covers a discovery window plus lead-in. */
export function newsFeedUrl(query: string): string {
  return (
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(`${query} when:7d`) +
    "&hl=en-IN&gl=IN&ceid=IN:en"
  );
}

// ── Extraction schema — its OWN copy, decoupled from the other two nets ──────
const ExtractedSourceSchema = z.object({ url: z.string(), snippet: z.string().optional() });
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
const RejectedSchema = z.object({ title: z.string().optional(), reason: z.string() });
const ExtractionSchema = z.object({
  films: z.array(ExtractedFilmSchema).default([]),
  rejected: z.array(RejectedSchema).default([]),
});

export function buildNewsPrompt(intent: NewsIntent, from: string, to: string, headlines: string[]): string {
  const kind = intent === "ott" ? "START STREAMING (digital release)" : "RELEASE IN CINEMAS (theatrical release)";
  return `You are a film-release extractor for The Big Screen Index. You read a list of NEWS HEADLINES about Indian cinema and extract the distinct FILMS that ${kind} in India inside a given window. You output DATA ONLY.

#1 RULE — USE ONLY THE HEADLINES (this is the most important rule):
- Every film and every field MUST come from the HEADLINES block below. Do NOT add anything from your own knowledge or memory, even if you are certain you know this film.
- If a field is not stated in the headlines, OMIT it. Never guess, infer, or estimate a title, platform, or date.
- You have no web access. The HEADLINES block is your ONLY ground truth.

#2 RULE — NEVER MANUFACTURE A DATE. THIS IS THE RULE THAT MATTERS MOST HERE:
- A headline that names a film WITHOUT stating when it releases must NOT get a date. Omit the date field entirely.
- Do NOT infer a date from the window, from "this week", from the fact that other films in the list have dates, or from a headline being recent. "Recently published" is not "releases on".
- A headline about a TEASER, TRAILER, poster, press meet, casting, box office, review, delay, postponement or a future/announced release is NOT evidence of a release in this window. Reject it.
- If a headline says a release is DELAYED, POSTPONED, or has a date OUTSIDE the window, reject it and say so in "rejected". Do not silently move it into the window.

REJECT NON-FILMS (put them in "rejected", do NOT put them in "films"):
- Reject anything that is a SERIES, SEASON, web series, anthology, TV show, reality show, or episodic show. Set reason "series".
- Reject trailers, teasers, songs, first-looks, award shows, interviews, and anything with no actual ${intent === "ott" ? "digital" : "theatrical"} release in the window. Set an appropriate reason.

WINDOW: ${from} to ${to} (inclusive), India. Edition: ${intent.toUpperCase()} — films that ${kind} in India in this window.

FOR EACH FILM:
- title: exactly as written in the headline.
- language: only if a headline states it (e.g. Tamil, Telugu, Hindi, Malayalam, Kannada, Marathi, Punjabi).
- platform: only if stated (the OTT service, e.g. Netflix, Prime Video, JioHotstar, Sun NXT, ETV Win, ManoramaMAX).
- date: the ${intent === "ott" ? "streaming" : "theatrical"} release date ONLY IF a headline states it, as YYYY-MM-DD. OMIT IT OTHERWISE.
- datesSeen: every distinct date the headlines attach to this film.
- isSeries: normally false — series belong in "rejected".
- confidence: "high" (named with an explicit date), "medium" (named as releasing this week without an explicit date), "low" (mentioned in passing).

HEADLINES (the ONLY ground truth):
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

OUTPUT — STRICT JSON ONLY (no markdown, no prose). Omit any field the headlines don't support:
{
  "films": [
    { "title": "...", "language": "...", "platform": "...", "date": "YYYY-MM-DD", "datesSeen": ["YYYY-MM-DD"], "isSeries": false, "confidence": "high" }
  ],
  "rejected": [ { "title": "...", "reason": "series" } ]
}`;
}

/** ONE cached LLM extraction over the deduped headline list. */
async function extract(
  intent: NewsIntent,
  from: string,
  to: string,
  headlines: string[]
): Promise<ExtractionResult> {
  return cached<ExtractionResult>(
    `reconcile:extract:news-net:${intent}:${from}:${to}`,
    async () => {
      const parsed = await callClaudeJSON(buildNewsPrompt(intent, from, to, headlines), ExtractionSchema, "opus");
      return {
        films: parsed.films as ExtractedFilm[],
        rejected: parsed.rejected as RejectedExtraction[],
        dateConflict: [],
      };
    },
    { ttlSeconds: EXTRACT_TTL }
  );
}

/**
 * PART 3 GUARD, IN CODE — a headline without a date cannot produce a dated
 * candidate.
 *
 * The prompt asks for this; this enforces it. WD-ENG-15 found Google News
 * behaving correctly on both liability films (contested-date coverage on
 * Goodachari 2, no false Aug-14 claim on Shabara), and that property is the
 * whole reason this net is worth wiring. An extractor that fills in a plausible
 * date would convert that strength into the exact failure Filmibeat produced.
 *
 * Prompts are not enforcement — WD-ENG-12 catalogued 19 rules that lived only in
 * prompt text and bound nothing. This is the code half.
 */
export function hasUsableDate(f: ExtractedFilm): boolean {
  return typeof f.date === "string" && ISO.test(f.date);
}

/** Fetch every query for this intent, degrading per query. Returns headlines. */
async function gatherHeadlines(intent: NewsIntent, from: string, to: string): Promise<string[]> {
  const queries = buildNewsQueries(intent, from, to);
  const seen = new Set<string>();
  const headlines: string[] = [];
  let ok = 0;

  for (const q of queries) {
    try {
      const { value } = await fetchCached<string>(
        `news-net:${intent}:${q.language ?? "dated"}:${q.query}:${from}`,
        newsFeedUrl(q.query),
        { ttlSeconds: FEED_TTL, responseType: "text" }
      );
      // REUSED verbatim from the news desk: same parser, same outlet-suffix
      // stripping, same "drop items missing title/link/date" discipline.
      for (const item of parseNewsFeed(value, (q.language ?? "Hindi") as Language)) {
        const key = item.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        headlines.push(item.title);
      }
      ok++;
    } catch (err) {
      log.warn(
        `  news-net [${intent}] query failed — ${q.query.slice(0, 48)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (ok === 0) throw new Error(`all ${queries.length} news queries failed`);
  return headlines.slice(0, MAX_HEADLINES);
}

/**
 * THE NET. Fails SAFE and ADDITIVE, exactly like the other two recall nets: any
 * failure degrades to [] with the WD-ENG-13 streak counter, and getCandidates is
 * byte-for-byte its pre-news-net result.
 */
export async function discoverNewsNet(
  intent: NewsIntent,
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  const degrade = (reason: string): DiscoveredFilm[] => {
    log.warn(degradationLine(SOURCE_LABEL, reason, recordSourceFailure(SOURCE_KEY)));
    return [];
  };

  let headlines: string[];
  try {
    headlines = await gatherHeadlines(intent, from, to);
  } catch (err) {
    return degrade(
      `[${intent}] headline gather failed — degrading to [] (other nets unaffected): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (headlines.length === 0) {
    return degrade(`[${intent}] every query returned 0 headlines — degrading to []`);
  }

  let extraction: ExtractionResult;
  try {
    extraction = await extract(intent, from, to, headlines);
  } catch (err) {
    log.error(`News net: extraction failed — degrading to []`, err instanceof Error ? err.message : err);
    return degrade(`[${intent}] extraction failed — ${err instanceof Error ? err.message : String(err)}`);
  }

  if (extraction.films.length === 0) {
    return degrade(
      `⚠ COVERAGE: ${headlines.length} headlines fetched but extracted 0 films — ` +
        `possible query rot or extractor break`
    );
  }

  const windowYear = Number.parseInt(from.slice(0, 4), 10);
  const films: DiscoveredFilm[] = [];
  let dropped = 0;

  for (const ai of extraction.films) {
    // PART 3, ENFORCED: no date → no candidate. Never a dated candidate from an
    // undated headline.
    if (!hasUsableDate(ai)) {
      dropped++;
      continue;
    }
    const search = ai.isSeries
      ? { movie: [], tv: [] }
      : await searchTitleTmdb(ai.title, { year: windowYear, ...(ai.language ? { language: ai.language } : {}) });
    const res = resolveTitleToTmdb(
      { title: ai.title, isSeries: ai.isSeries, ...(ai.language ? { language: ai.language } : {}) },
      search,
      windowYear
    );
    if (res.kind !== "movie" || !res.hit) continue;     // series / unverified — dropped
    const iso = res.hit.originalLanguage;
    if (!iso || !INDIAN_LANG_CODES.has(iso)) continue;  // non-Indian — dropped
    films.push(toDiscoveredFilm(ai, res.hit, windowYear, intent));
  }

  log.info(
    `News net [${intent}]: ${headlines.length} headlines → ${extraction.films.length} extracted ` +
      `(${dropped} undated, dropped) → ${films.length} resolved Indian film(s)`
  );

  const before = recordSourceSuccess(SOURCE_KEY);
  if (before.consecutiveFailures > 0) log.success(recoveryLine(SOURCE_LABEL, before));

  return films;
}

function yearOf(date: string | undefined, fallback: number): number {
  if (date && ISO.test(date)) {
    const y = Number.parseInt(date.slice(0, 4), 10);
    if (Number.isFinite(y) && y > 1900) return y;
  }
  return fallback;
}

/** Build a DiscoveredFilm from a resolved news find. Its OWN provenance tag. */
function toDiscoveredFilm(
  ai: ExtractedFilm,
  hit: { id: number; title: string; originalLanguage?: string; year?: number },
  windowYear: number,
  intent: NewsIntent
): DiscoveredFilm {
  const language = languageForCode(hit.originalLanguage);
  const date = ai.date && ISO.test(ai.date) ? ai.date : undefined;
  return {
    title: hit.title,
    normalizedTitle: normalizeTitle(hit.title),
    year: yearOf(date, hit.year ?? windowYear),
    language,
    ...(date ? { releaseDate: date } : {}),
    releaseType: intent === "ott" ? "digital" : "theatrical",
    tmdbId: hit.id,
    ...(intent === "ott" && date ? { ottDate: date } : {}),
    ...(ai.platform ? { platform: ai.platform } : {}),
    ...(ai.sources?.[0]?.url ? { sourceUrl: ai.sources[0]!.url } : {}),
    // Its OWN net tag, so corroboration counts it as independent evidence.
    foundIn: ["news"],
    perSource: {},
  };
}
