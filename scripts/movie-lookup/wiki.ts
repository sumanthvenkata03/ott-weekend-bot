// scripts/movie-lookup/wiki.ts
// Wikipedia background source for the internal movie-lookup tool.
//
// Uses ONLY Wikipedia's official APIs (no scraping):
//   1. action API  list=search   — find the best-matching article by title(+year)
//   2. REST v1     page/summary   — the article summary/extract + canonical URL
//
// Uncached (no cache.sqlite writes). Confidence-guarded: if the best search hit
// doesn't share the film's title words, or the summary is a disambiguation page,
// we report "not found" rather than attach a wrong article.
//
// Adapter-shaped (BACKGROUND_SOURCES) so another background source can be added
// later without touching the endpoint.

import { ofetch } from "ofetch";

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const UA = "TBSI-movie-lookup/1.0 (internal reference tool; contact: local)";

export interface BackgroundResult {
  source: string;
  found: boolean;
  title?: string;
  description?: string;
  extract?: string;
  url?: string;
  thumbnail?: string;
  raw?: unknown;
}

export interface BackgroundAdapter {
  name: string;
  getMovieBackground(title: string, year?: number): Promise<BackgroundResult>;
}

const STOP = new Set(["the", "a", "an", "of", "and", "part", "film", "movie"]);

export function titleTokens(s: string): string[] {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t));
}

/** Overlap ratio of the film's significant title tokens present in a candidate. */
export function overlapRatio(filmTitle: string, candidate: string): number {
  const a = titleTokens(filmTitle);
  const b = new Set(titleTokens(candidate));
  if (a.length === 0) return 0;
  const hit = a.filter((t) => b.has(t)).length;
  return hit / a.length;
}

interface WikiSearchHit { title: string; snippet?: string; }
interface WikiSearchResp { query?: { search?: WikiSearchHit[] } }
interface WikiSummary {
  type?: string;
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  thumbnail?: { source?: string };
}

async function wikiSearch(title: string, year?: number): Promise<WikiSearchHit[]> {
  const srsearch = `${title}${year ? " " + year : ""} film`;
  try {
    const res = await ofetch<WikiSearchResp>(WIKI_API, {
      query: { action: "query", list: "search", srsearch, srlimit: "6", format: "json", origin: "*" },
      headers: { "User-Agent": UA, Accept: "application/json" },
      retry: 1,
    });
    return res.query?.search ?? [];
  } catch {
    return [];
  }
}

async function wikiSummary(pageTitle: string): Promise<WikiSummary | null> {
  try {
    return await ofetch<WikiSummary>(WIKI_REST + encodeURIComponent(pageTitle.replace(/ /g, "_")), {
      headers: { "User-Agent": UA, Accept: "application/json" },
      retry: 1,
    });
  } catch {
    return null;
  }
}

export const wikipediaSource: BackgroundAdapter = {
  name: "wikipedia",
  async getMovieBackground(title, year) {
    const hits = await wikiSearch(title, year);
    // Rank candidates: title-token overlap first, then a small bonus for a
    // "(… film)" article or the year appearing in the title.
    const ranked = hits
      .map((h) => {
        let s = overlapRatio(title, h.title);
        if (/\(.*film.*\)/i.test(h.title)) s += 0.2;
        if (year && h.title.includes(String(year))) s += 0.1;
        return { hit: h, score: s };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    // Confidence guard: require real title overlap.
    if (!best || best.score < 0.5) {
      return { source: "wikipedia", found: false, raw: { search: hits } };
    }
    const summary = await wikiSummary(best.hit.title);
    if (!summary || summary.type === "disambiguation" || !summary.extract) {
      return { source: "wikipedia", found: false, raw: { search: hits, summary } };
    }
    // Re-check overlap against the RESOLVED article title (redirects can drift).
    if (overlapRatio(title, summary.title ?? best.hit.title) < 0.5) {
      return { source: "wikipedia", found: false, raw: { search: hits, summary } };
    }
    return {
      source: "wikipedia",
      found: true,
      title: summary.title ?? best.hit.title,
      description: summary.description,
      extract: summary.extract,
      url: summary.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent((summary.title ?? best.hit.title).replace(/ /g, "_"))}`,
      thumbnail: summary.thumbnail?.source,
      raw: { search: hits, summary },
    };
  },
};

export const BACKGROUND_SOURCES: BackgroundAdapter[] = [wikipediaSource];

/** Aggregate background across registered sources (first found wins per source). */
export async function aggregateBackground(title: string, year?: number): Promise<BackgroundResult[]> {
  const settled = await Promise.allSettled(BACKGROUND_SOURCES.map((s) => s.getMovieBackground(title, year)));
  return settled.map((r, i) =>
    r.status === "fulfilled" ? r.value : { source: BACKGROUND_SOURCES[i]!.name, found: false }
  );
}
