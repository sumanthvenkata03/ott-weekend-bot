// src/research/sources/tavily.ts
// Keyed signal source. Queries the Tavily Search API (POST /search) for recent
// web coverage of a film and returns the raw result snippets for OUR
// consolidation to judge — NOT Tavily's own synthesis (include_answer is off).
// One cached call (24h) under a research:tavily:* key, so re-runs cost zero
// credits. Reads TAVILY_API_KEY from process.env directly (never the eager
// config) so the standalone CLI keeps working.
//
// Cost: search_depth "basic" = 1 credit/call (advanced = 2). We want cheap raw
// snippets for our own consolidation, so basic + no answer + no raw_content.
import { fetchCached } from "../http.js";
import type { RawSourceItem, RawSourceResult, ResearchQuery } from "../types.js";

const TAVILY_TTL = 86400; // 24h — web coverage drifts slowly; tunable
const SEARCH_URL = "https://api.tavily.com/search";
const SEARCH_DEPTH = "basic"; // 1 credit (advanced = 2); cheapest useful depth
const MAX_RESULTS = 6;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  // Only returned for topic:"news"; absent on topic:"general".
  published_date?: string;
}
interface TavilyResponse {
  results?: TavilyResult[];
  answer?: string;
  query?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** The key rides in the Authorization header — strip it from any error string. */
function redactKey(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/tvly-[A-Za-z0-9._-]+/g, "tvly-***");
}

function fail(error: unknown): RawSourceResult {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    source: "tavily",
    kind: "signal",
    ok: false,
    items: [],
    error: redactKey(msg),
    fetchedAt: nowIso(),
  };
}

function isAvailable(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

async function queryTavily(q: ResearchQuery): Promise<RawSourceResult> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return fail("TAVILY_API_KEY not set");

  try {
    // Exact-phrase the title so results are ABOUT this film; append year and
    // language only when present, then anchor with the word "film".
    const query =
      `"${q.title}"${q.year ? ` ${q.year}` : ""}${q.language ? ` ${q.language}` : ""} film`;
    const cacheKey = `research:tavily:${q.title.toLowerCase()}:${q.year ?? ""}`;

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

    // Map up to max_results raw snippets. Zero results is a SUCCESSFUL empty
    // answer (thin/obscure film), not an error — ok stays true.
    const results = (res.value.results ?? []).slice(0, MAX_RESULTS);
    const items: RawSourceItem[] = results.map((r) => ({
      ...(r.title ? { title: r.title } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.content ? { snippet: r.content } : {}),
      ...(r.published_date ? { publishedAt: r.published_date } : {}),
      ...(typeof r.score === "number" ? { meta: { score: r.score } } : {}),
    }));

    return {
      source: "tavily",
      kind: "signal",
      ok: true,
      items,
      raw: res.value,
      fetchedAt: nowIso(),
      cached: res.cached,
    };
  } catch (err) {
    return fail(err);
  }
}

export const tavily = {
  name: "tavily",
  kind: "signal",
  requiresKey: true,
  isAvailable,
  query: queryTavily,
} as const satisfies import("../types.js").ResearchSource;
