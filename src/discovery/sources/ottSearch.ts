// src/discovery/sources/ottSearch.ts
// The SHARED AI-search net — ONE implementation used by both discovery's OTT
// source (discoverOttSearch) and the reconcile layer (which re-exports runAiNet
// via src/reconcile/ai-net.ts). It lives in discovery because discovery OWNS
// finding; reconcile OWNS verification.
//
//   1. Free-text Tavily sibling. We do NOT reuse tavily.query (it hard-builds a
//      single-TITLE query); the net needs OPEN per-edition / per-language /
//      per-platform discovery queries. We reuse tavily.ts's transport contract:
//      the key is read from process.env.TAVILY_API_KEY directly, the call goes
//      through fetchCached (POST /search, 24h cache, basic depth = 1 credit,
//      include_answer off so we get raw snippets for OUR extractor to judge).
//   2. ONE batched callClaudeJSON extraction per edition over ALL that edition's
//      snippets. The prompt mirrors consolidate.ts discipline: use ONLY the
//      provided snippets, never your own knowledge, omit unsupported fields,
//      reject anything that is a series / season / anthology / show. The LLM may
//      output title / language / platform / date / source ONLY.
//
// discoverOttSearch then RESOLVES each extracted film to a TMDb id (shared
// resolveTitleToTmdb) and emits a DiscoveredFilm carrying the PRESS-sourced OTT
// date that TMDb's release_type=4 net misses (the Blast case).

import { z } from "zod";
import { createHash } from "node:crypto";
import { callClaudeJSON } from "../../content/claude.js";
import { fetchCached } from "../../research/http.js";
import { cached } from "../../shared/cache.js";
import { log } from "../../shared/logger.js";
import { searchTitleTmdb, type TmdbTitleHit } from "../../ingestion/releases/tmdb.js";
import { normalizeTitle } from "../normalize.js";
import { resolveTitleToTmdb, languageForCode, INDIAN_LANG_CODES } from "./resolveTitle.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { DateConflictExtraction, ExtractedFilm, ExtractionResult, RejectedExtraction } from "../../reconcile/types.js";
import type { DiscoveredFilm } from "../types.js";

const SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_TTL = 86400;          // 24h — matches the per-title tavily source
const EXTRACT_TTL = 86400;         // 24h — keeps the gate hash stable across an --approve re-run
const SEARCH_DEPTH = "basic";      // 1 credit (advanced = 2)
const MAX_RESULTS = 6;             // per query
const MAX_SNIPPETS = 48;           // cap fed to the extractor (prompt bound)

// OTT services we probe per language (kept small to stay low-cost).
const OTT_PLATFORMS = ["Netflix", "Prime Video", "JioHotstar", "Aha", "SonyLIV"];

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}
interface TavilyResponse {
  results?: TavilyResult[];
}

interface Snippet {
  title?: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

function redactKey(msg: string): string {
  return msg.replace(/Bearer\s+\S+/gi, "Bearer ***").replace(/tvly-[A-Za-z0-9._-]+/g, "tvly-***");
}

/** Free-text Tavily search — one cached POST. Never throws; returns [] on failure. */
async function tavilySearch(query: string): Promise<Snippet[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const cacheKey = `reconcile:tavily:${createHash("sha1").update(query).digest("hex").slice(0, 16)}`;
  try {
    const res = await fetchCached<TavilyResponse>(cacheKey, SEARCH_URL, {
      ttlSeconds: TAVILY_TTL,
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        query,
        search_depth: SEARCH_DEPTH,
        max_results: MAX_RESULTS,
        topic: "general",
        include_answer: false,
        include_raw_content: false,
      },
    });
    return (res.value.results ?? [])
      .filter((r): r is TavilyResult & { url: string } => !!r.url)
      .map((r) => ({
        ...(r.title ? { title: r.title } : {}),
        url: r.url,
        ...(r.content ? { snippet: r.content } : {}),
        ...(r.published_date ? { publishedAt: r.published_date } : {}),
      }));
  } catch (err) {
    log.warn(`reconcile tavily query failed: ${redactKey(err instanceof Error ? err.message : String(err))}`);
    return [];
  }
}

/** Per-edition, per-language (+ per-platform for OTT) discovery queries. */
export function buildQueries(pillar: string, languages: string[], window: BucketWindow): string[] {
  const dates = `${window.start} to ${window.end}`;
  const qs: string[] = [];
  if (pillar === "theatrical") {
    for (const lang of languages) {
      qs.push(`new ${lang} movie theatrical release India this week ${dates}`);
    }
    qs.push(`Indian films releasing in theatres this weekend ${dates}`);
  } else {
    for (const lang of languages) {
      qs.push(`new ${lang} movie streaming OTT release India ${dates}`);
      for (const plat of OTT_PLATFORMS) {
        qs.push(`new ${lang} movie streaming on ${plat} ${dates}`);
      }
    }
    qs.push(`new Indian movies OTT digital release this week ${dates}`);
  }
  return qs;
}

// ── Extraction schema (permissive/all-optional except title + sources) ──────
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
  sources: z.array(ExtractedSourceSchema).min(1),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});
const RejectedSchema = z.object({
  title: z.string().optional(),
  reason: z.string(),
});
const DateConflictSchema = z.object({
  title: z.string().optional(),
  datesSeen: z.array(z.string()).optional(),
  note: z.string().optional(),
});
const ExtractionSchema = z.object({
  films: z.array(ExtractedFilmSchema).default([]),
  rejected: z.array(RejectedSchema).default([]),
  dateConflict: z.array(DateConflictSchema).default([]),
});

function buildExtractionPrompt(
  pillar: string,
  window: BucketWindow,
  snippets: Snippet[]
): string {
  const editionLine =
    pillar === "theatrical"
      ? "Edition: THEATRICAL — films OPENING IN CINEMAS in India in this window."
      : "Edition: OTT — films that START STREAMING (digital release) in India in this window.";
  const sources = JSON.stringify(snippets, null, 2);
  return `You are a film-release extractor for The Big Screen Index. You read raw web-search snippets and extract the distinct FILMS releasing in India in a given window. You output DATA ONLY.

#1 RULE — USE ONLY THE PROVIDED SNIPPETS (this is the most important rule):
- Every film and every field MUST come from the SNIPPETS block below. Do NOT add anything from your own knowledge or memory, even if you are certain you know this film.
- If a field is not stated in the snippets, OMIT it. Never guess, infer, or estimate a title, platform, or date.
- You have no web access. The SNIPPETS block is your ONLY ground truth.

YOU MAY OUTPUT ONLY: title, language, platform, date, and the snippet URL(s) that support each film. Do NOT output cast, synopsis, poster, rating, runtime, or any descriptive copy — those are sourced elsewhere, never by you.

REJECT NON-FILMS (put them in "rejected", do NOT put them in "films"):
- Reject anything that is a SERIES, SEASON, web series, anthology, TV show, reality show, or episodic show. A title described as "Season 1/2", "series", "episodes", "show", or "part of a season" is NOT a film. Set reason "series".
- Reject trailers, teasers, songs, first-looks, and anything with no actual release in the window. Set an appropriate reason.

WINDOW: ${window.start} to ${window.end} (inclusive), India.
${editionLine}

FOR EACH FILM:
- title: exactly as written in the snippets.
- language: only if the snippets state it.
- platform: only if stated (the OTT service for a streaming release; omit for theatrical).
- date: the release/stream date if stated (YYYY-MM-DD when possible).
- datesSeen: EVERY distinct date the snippets attach to this film (so date conflicts stay visible).
- isSeries: true only if you are putting it in films by mistake — normally series go to "rejected".
- sources: the URL(s) of the snippet(s) that mention this film. REQUIRED — at least one. A film with no snippet URL must NOT be emitted.
- confidence: "high" (multiple snippets / authoritative), "medium" (one decent snippet), "low" (thin/indirect).

DATE CONFLICTS:
- If snippets give DIFFERENT release dates for the same film, STILL extract it once, list all dates in datesSeen, AND add an entry to "dateConflict" with the title, the dates, and a one-line note.

SNIPPETS (the ONLY ground truth — JSON array):
${sources}

OUTPUT — STRICT JSON ONLY (no markdown, no prose). Omit any field the snippets don't support:
{
  "films": [
    { "title": "...", "language": "...", "platform": "...", "date": "YYYY-MM-DD", "datesSeen": ["YYYY-MM-DD"], "isSeries": false, "sources": [ { "url": "...", "snippet": "..." } ], "confidence": "high" }
  ],
  "rejected": [ { "title": "...", "reason": "series" } ],
  "dateConflict": [ { "title": "...", "datesSeen": ["YYYY-MM-DD", "YYYY-MM-DD"], "note": "..." } ]
}`;
}

function dedupeSnippets(snippets: Snippet[]): Snippet[] {
  const seen = new Set<string>();
  const out: Snippet[] = [];
  for (const s of snippets) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= MAX_SNIPPETS) break;
  }
  return out;
}

/**
 * Run the AI-search net for ONE edition: fan out the Tavily queries, dedupe the
 * snippets, and run ONE cached LLM extraction. Degrades to an empty result (no
 * throw) if Tavily has no key or the extraction fails. Exactly ONE LLM call per
 * edition on a cold cache; zero on a warm one. Shared by discovery (OTT search)
 * and reconcile (via the ai-net.ts re-export).
 */
export async function runAiNet(
  pillar: string,
  languages: string[],
  window: BucketWindow
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { films: [], rejected: [], dateConflict: [] };

  if (!process.env.TAVILY_API_KEY) {
    log.warn(`AI net [${pillar}]: TAVILY_API_KEY not set — skipping (pool reconciles on TMDb only)`);
    return empty;
  }

  const queries = buildQueries(pillar, languages, window);
  log.info(`AI net [${pillar}]: ${queries.length} Tavily queries (${languages.join(", ")})`);
  const all = (await Promise.all(queries.map((q) => tavilySearch(q)))).flat();
  const snippets = dedupeSnippets(all);
  log.info(`AI net [${pillar}]: ${all.length} raw → ${snippets.length} unique snippets`);
  if (snippets.length === 0) return empty;

  const cacheKey = `reconcile:extract:${pillar}:${window.start}:${window.end}:${languages.join(",")}`;
  try {
    const result = await cached<ExtractionResult>(
      cacheKey,
      async () => {
        const prompt = buildExtractionPrompt(pillar, window, snippets);
        const parsed = await callClaudeJSON(prompt, ExtractionSchema, "opus");
        // zod strips absent keys; cast each ExtractedFilm to the pure interface.
        return {
          films: parsed.films as ExtractedFilm[],
          rejected: parsed.rejected as RejectedExtraction[],
          dateConflict: parsed.dateConflict as DateConflictExtraction[],
        };
      },
      { ttlSeconds: EXTRACT_TTL }
    );
    log.info(
      `AI net [${pillar}]: extracted ${result.films.length} film(s), ` +
        `rejected ${result.rejected.length}, dateConflict ${result.dateConflict.length}`
    );
    return result;
  } catch (err) {
    log.error(`AI net [${pillar}]: extraction failed — degrading to TMDb-only`, err instanceof Error ? err.message : err);
    return empty;
  }
}

// ── Discovery OTT source ─────────────────────────────────────────────────────

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function yearOf(date: string | undefined, fallback: number): number {
  if (date && ISO.test(date)) {
    const y = Number.parseInt(date.slice(0, 4), 10);
    if (Number.isFinite(y) && y > 1900) return y;
  }
  return fallback;
}

/** Build a DiscoveredFilm from a resolved AI-net OTT find (Indian-guarded upstream). */
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
    ...(ai.sources?.[0]?.url ? { sourceUrl: ai.sources[0]!.url } : {}),
    foundIn: ["ai-ott"],
    perSource: {},
  };
}

/**
 * Discovery OTT-SEARCH net. Runs the shared Tavily+Claude extraction over the
 * window, resolves each extracted film to a TMDb id (shared resolveTitleToTmdb),
 * and emits DiscoveredFilm OTT candidates carrying the PRESS-sourced OTT date
 * (ottDate) that TMDb's release_type=4 net misses (the Blast case). Series /
 * non-Indian / unresolved leads are dropped — discovery only SURFACES valid
 * films; reconcile does the rejection accounting. Never throws (runAiNet
 * degrades to [] on no Tavily key / extraction failure).
 */
export async function discoverOttSearch(
  languages: string[],
  from: string,
  to: string
): Promise<DiscoveredFilm[]> {
  const window: BucketWindow = { start: from, end: to, dateField: "ott", label: "OTT search" };
  const extraction = await runAiNet("ott", languages, window);
  if (extraction.films.length === 0) return [];

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
  log.info(`OTT search: ${extraction.films.length} extracted → ${films.length} resolved Indian film(s)`);
  return films;
}
