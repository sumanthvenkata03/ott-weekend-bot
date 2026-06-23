// src/research/sources/googleNews.ts
// No-key signal source. Fetches the Google News RSS search feed for the
// exact-phrase title (plus year when known), parses the XML with
// fast-xml-parser, and maps up to 15 items. Exact-phrasing + year cuts the
// cross-film pollution seen in Step 1 (a 2024 title pulling its director's
// newer film); it won't fully exclude name-drops — that's the Step-3 LLM's
// job. Raw feed is cached (1h) at the HTTP layer; failures degrade to
// { ok:false, error }.
import { XMLParser } from "fast-xml-parser";
import { fetchCached } from "../http.js";
import type { RawSourceItem, RawSourceResult, ResearchQuery } from "../types.js";

const TTL = 60 * 60; // 1 hour
const MAX_ITEMS = 15;

// parseTagValue:false keeps every leaf as a string (no surprise numeric
// coercion of titles/dates). Entities are still decoded by default.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

interface RssItem {
  title?: unknown;
  link?: unknown;
  pubDate?: unknown;
  description?: unknown;
  source?: unknown;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceName(source: unknown): string | undefined {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const t = (source as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t;
  }
  return undefined;
}

async function queryGoogleNews(q: ResearchQuery): Promise<RawSourceResult> {
  const fetchedAt = nowIso();
  try {
    // Exact-phrase the title; append the year when known to tighten results.
    const term = `"${q.title}"${q.year ? ` ${q.year}` : ""}`;
    const url =
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(term) +
      "&hl=en-IN&gl=IN&ceid=IN:en";
    // Year is part of the cache key so a tightened query never reads back the
    // old title-only cached feed.
    const key = `research:googleNews:${q.title.toLowerCase()}:${q.year ?? ""}`;
    const { value, cached } = await fetchCached<string>(key, url, {
      ttlSeconds: TTL,
      responseType: "text",
    });

    const doc = parser.parse(value) as {
      rss?: { channel?: { item?: RssItem | RssItem[] } };
    };
    const rawItems = doc.rss?.channel?.item;
    const arr: RssItem[] = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

    const items: RawSourceItem[] = arr.slice(0, MAX_ITEMS).map((it) => {
      const out: RawSourceItem = {};
      if (it.title != null) out.title = String(it.title);
      if (it.link != null) out.url = String(it.link);
      if (it.pubDate != null) out.publishedAt = String(it.pubDate);
      if (it.description != null) {
        const snip = stripHtml(String(it.description));
        if (snip) out.snippet = snip;
      }
      const src = sourceName(it.source);
      if (src) out.meta = { source: src };
      return out;
    });

    return {
      source: "googleNews",
      kind: "signal",
      ok: true,
      items,
      raw: arr.slice(0, MAX_ITEMS),
      fetchedAt,
      cached,
    };
  } catch (err) {
    return {
      source: "googleNews",
      kind: "signal",
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : String(err),
      fetchedAt,
    };
  }
}

export const googleNews = {
  name: "googleNews",
  kind: "signal",
  requiresKey: false,
  isAvailable: () => true,
  query: queryGoogleNews,
} as const satisfies import("../types.js").ResearchSource;
