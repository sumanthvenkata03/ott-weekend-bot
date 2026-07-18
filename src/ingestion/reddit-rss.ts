// src/ingestion/reddit-rss.ts
// READS-ONLY Reddit access (HARD LAW L1: never posts/comments/votes/auths).
// Native RSS/Atom endpoints only, ZERO cost (no Tavily, no LLM). Polite +
// fragile-by-design (L4): a fixed User-Agent, a 10s timeout, and ANY failure
// degrades to [] with one ⚠ log line (the Filmibeat-403 pattern).
//
// Atom is parsed with fast-xml-parser (already a dep, used by googleNews.ts) —
// no hand-rolled XML, no new dependency.

import { ofetch } from "ofetch";
import { XMLParser } from "fast-xml-parser";
import { log } from "../shared/logger.js";

export interface RedditPost {
  id: string;
  title: string;
  link: string;
  author: string;
  sub: string;
  publishedISO: string;
  snippet: string;
}

/** L4 — polite client identity + a hard ceiling on how long we ever wait. */
const USER_AGENT = "tbsi-pipeline/1.0 (+https://thebigscreenindex.com)";
const TIMEOUT_MS = 10_000;

/**
 * Per-language subreddit map — EDITABLE. The owner verifies a sub name before
 * enabling a new language; unknown/unverified subs ship COMMENTED-OUT and are
 * NEVER guessed (a wrong sub silently returns nothing or the wrong scene).
 */
export const SUBREDDIT_MAP: Record<string, string> = {
  Telugu: "tollywood",
  Tamil: "kollywood",
  Malayalam: "MalayalamMovies",
  Hindi: "bollywood",
  // Kannada:  "kannada",       // candidate — owner to verify sub name before enabling
  // Punjabi:  "Punjabi",       // candidate — owner to verify sub name before enabling
  // Marathi:  "MarathiCinema", // candidate — owner to verify sub name before enabling
};

// parseTagValue:false keeps every leaf a string (no numeric coercion of titles/
// dates); attributes kept so <link href> and <content type> survive.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
});

/** Reddit <content> is HTML — strip to a plain snippet (googleNews.ts idiom). */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** A leaf may be a bare string or `{ "#text": "…", "@_attr": … }` under fxp. */
function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const t = (v as Record<string, unknown>)["#text"];
    if (typeof t === "string") return t;
  }
  return "";
}

/**
 * Build the subreddit search RSS URL. URLSearchParams cleanly percent-encodes
 * punctuation-heavy titles (dots, bang, quotes, spaces) so an "Oh..! Sukumari"
 * query never breaks the request. Exported for unit testing (RD).
 */
export function buildSearchUrl(sub: string, query: string): string {
  const u = new URL(`https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss`);
  u.searchParams.set("q", query);
  u.searchParams.set("restrict_sr", "1");
  u.searchParams.set("sort", "new");
  return u.toString();
}

/** Build the subreddit /new/ RSS URL. Exported for testing. */
export function buildNewUrl(sub: string): string {
  return `https://www.reddit.com/r/${encodeURIComponent(sub)}/new/.rss`;
}

/**
 * Parse a Reddit Atom feed → RedditPost[]. PURE (no network) — the fixture-based
 * unit test drives this directly. A non-Atom / error body (e.g. an HTML 429
 * page) parses to no <entry> and returns [].
 */
export function parseAtomFeed(xml: string, sub: string): RedditPost[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const feed = (doc as { feed?: { entry?: unknown } } | undefined)?.feed;
  if (!feed) return [];
  const raw = feed.entry;
  const entries = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const posts: RedditPost[] = [];
  for (const e of entries as Record<string, unknown>[]) {
    const linkNode = e.link as { "@_href"?: string } | string | undefined;
    const link = (linkNode && typeof linkNode === "object" ? linkNode["@_href"] : asText(linkNode)) ?? "";
    const id = asText(e.id) || link;
    if (!id && !link) continue;
    posts.push({
      id,
      title: asText(e.title),
      link,
      author: asText((e.author as { name?: unknown } | undefined)?.name),
      sub,
      publishedISO: asText(e.published) || asText(e.updated) || "",
      snippet: stripHtml(asText(e.content)),
    });
  }
  return posts;
}

/** The one fetch path: polite headers, 10s ceiling, fail-soft to [] + one ⚠. */
async function fetchAtom(url: string, sub: string): Promise<RedditPost[]> {
  try {
    const xml = await ofetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      responseType: "text",
    });
    return parseAtomFeed(String(xml), sub);
  } catch (err) {
    log.warn(`reddit-rss: ${url} failed — ${err instanceof Error ? err.message : String(err)} (degrading to [])`);
    return [];
  }
}

export interface SearchOpts {
  /** Reserved for future tuning (limit, sort); shadow build takes defaults. */
  readonly _reserved?: never;
}

/** r/<sub>/search.rss?q=…&restrict_sr=1&sort=new → RedditPost[] (fail-soft []). */
export function fetchSubredditSearch(sub: string, query: string, _opts: SearchOpts = {}): Promise<RedditPost[]> {
  return fetchAtom(buildSearchUrl(sub, query), sub);
}

/** r/<sub>/new/.rss → RedditPost[] (fail-soft []). */
export function fetchSubredditNew(sub: string): Promise<RedditPost[]> {
  return fetchAtom(buildNewUrl(sub), sub);
}
