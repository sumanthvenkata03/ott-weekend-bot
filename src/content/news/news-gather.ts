// src/content/news/news-gather.ts
// NEWS DESK · A — GATHER. Per-language film-news RSS off Google News. ZERO cost
// (no key, no quota) and READ-ONLY.
//
// APPROACH-A NOTE (ruling R1): this does NOT import src/research/sources/
// googleNews.ts. That module exact-phrase-quotes its query (`"${title}"`) and
// keys its cache by film title — correct for per-film research, fatal for
// free-form news queries (an exact-phrase "Tamil cinema news when:2d" returns
// ~nothing and the when: operator dies inside the quotes). We reuse its IDIOM
// and its HTTP cache layer (fetchCached → the shared http_cache table), leaving
// googleNews.ts untouched for the research pipeline.
//
// FRESHNESS is enforced twice, on purpose: `when:2d` narrows at the source (a
// smaller feed, fewer bytes) and withinWindow() filters to WINDOW_HOURS in code.
// Only the code-side filter is authoritative — Google's when: is approximate and
// untestable; ours is pure and unit-tested.
//
// ⚠️ ITEM URL IS A REDIRECT. Google News RSS <link> is always a
// news.google.com/rss/articles/CBMi… stub, never the outlet's own URL. Two
// consequences the rest of the desk is built around:
//   1. Outlet tiering CANNOT read the host — it matches on the <source> NAME
//      (see news-score.ts, tierOfOutlet).
//   2. This URL is a DEDUPE KEY ONLY. It is never a citable receipt. The N1
//      sourceUrl comes from verification (news-verify.ts) or the story is held.

import { XMLParser } from "fast-xml-parser";
import { fetchCached } from "../../research/http.js";
import { editorialTodayStamp } from "../../shared/editorial-clock.js";
import { log } from "../../shared/logger.js";
import type { Language } from "../../shared/types.js";

/** Overlap-safe window for a once-daily run (24h + 2h of slack). */
export const WINDOW_HOURS = 26;

/** Feed cache TTL. Keyed by IST date too, so a same-day re-run is free. */
const FEED_TTL_SECONDS = 30 * 60;

/** Hard cap per query — the feed routinely returns 45-90 items. */
const MAX_ITEMS_PER_QUERY = 40;

/**
 * EDITABLE — the seven per-language film-news queries. Deliberately broad: the
 * scorer (not the query) does the editorial narrowing, so the shadow week can
 * see what a loose net catches before we tighten. Google News search operators
 * are allowed here; `when:2d` is appended by the fetcher, not written inline.
 */
export const NEWS_QUERIES: ReadonlyArray<{ language: Language; query: string }> = [
  { language: "Hindi",     query: "Bollywood Hindi film news OTT release" },
  { language: "Telugu",    query: "Telugu cinema Tollywood film news OTT release" },
  { language: "Tamil",     query: "Tamil cinema Kollywood film news OTT release" },
  { language: "Malayalam", query: "Malayalam cinema Mollywood film news OTT release" },
  { language: "Kannada",   query: "Kannada cinema Sandalwood film news OTT release" },
  { language: "Marathi",   query: "Marathi cinema film news OTT release" },
  { language: "Bengali",   query: "Bengali cinema Bangla film news OTT release" },
];

/** A gathered headline, before any scoring. */
export interface NewsItem {
  title: string;
  /** Google News redirect stub — dedupe key only, NEVER a citable receipt. */
  url: string;
  /** Outlet name from <source> — the ONLY tierable signal (host is useless). */
  source: string;
  publishedISO: string;
  language: Language;
}

// Same parser config as googleNews.ts: every leaf stays a string (no surprise
// numeric coercion of a title like "72" or a date), entities still decoded.
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
  source?: unknown;
}

/** <source> is either a bare string or { "#text": name } — googleNews.ts idiom. */
function sourceName(source: unknown): string {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const t = (source as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * Google News appends " - Outlet" to every headline. That suffix is formatting,
 * not content: left in, it inflates token overlap between two unrelated stories
 * from the same outlet and deflates it across outlets — exactly backwards for
 * cross-outlet clustering. Stripped ONLY when it matches the item's own source.
 */
export function stripOutletSuffix(title: string, source: string): string {
  if (!source) return title;
  const suffix = ` - ${source}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/** True when `publishedISO` falls inside the trailing `hours` window. PURE. */
export function withinWindow(publishedISO: string, nowMs: number, hours = WINDOW_HOURS): boolean {
  const t = Date.parse(publishedISO);
  if (Number.isNaN(t)) return false;      // unparseable date → not fresh, not guessed
  if (t > nowMs + 60 * 60 * 1000) return false; // >1h in the future → bad data
  return nowMs - t <= hours * 60 * 60 * 1000;
}

/**
 * Parse one RSS payload into items. PURE (no I/O) so the clustering and window
 * suites can drive it off fixtures. Items missing a title/link/date are dropped
 * rather than defaulted — a headline with a guessed date is worse than no item.
 */
export function parseNewsFeed(xml: string, language: Language): NewsItem[] {
  const doc = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const raw = doc.rss?.channel?.item;
  const arr: RssItem[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const out: NewsItem[] = [];
  for (const it of arr.slice(0, MAX_ITEMS_PER_QUERY)) {
    if (it.title == null || it.link == null || it.pubDate == null) continue;
    const source = sourceName(it.source);
    const published = new Date(String(it.pubDate));
    if (Number.isNaN(published.getTime())) continue;
    out.push({
      title: stripOutletSuffix(String(it.title), source),
      url: String(it.link),
      source,
      publishedISO: published.toISOString(),
      language,
    });
  }
  return out;
}

/** The Google News RSS search URL for one query, narrowed to the last 2 days. */
export function feedUrl(query: string): string {
  return (
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(`${query} when:2d`) +
    "&hl=en-IN&gl=IN&ceid=IN:en"
  );
}

/**
 * Gather across all seven languages. One language failing (network, malformed
 * XML) degrades to a warning and an empty list — a dead Kannada feed must not
 * take the edition down. Returns items already filtered to the fresh window.
 */
export async function gatherNews(nowMs: number = Date.now()): Promise<NewsItem[]> {
  const stamp = editorialTodayStamp(new Date(nowMs));
  const all: NewsItem[] = [];

  for (const { language, query } of NEWS_QUERIES) {
    try {
      const { value, cached } = await fetchCached<string>(
        `news:gather:${language}:${stamp}`,
        feedUrl(query),
        { ttlSeconds: FEED_TTL_SECONDS, responseType: "text" }
      );
      const parsed = parseNewsFeed(value, language);
      const fresh = parsed.filter((i) => withinWindow(i.publishedISO, nowMs));
      all.push(...fresh);
      log.info(
        `  ${language.padEnd(10)} ${String(fresh.length).padStart(2)} fresh / ${String(parsed.length).padStart(2)} parsed${cached ? " (cached)" : ""}`
      );
    } catch (err) {
      log.warn(`  ${language.padEnd(10)} feed failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return all;
}
