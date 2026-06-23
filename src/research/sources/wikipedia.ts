// src/research/sources/wikipedia.ts
// No-key source. Three best-effort HTTP calls against en.wikipedia.org:
//   1. MediaWiki search  → resolve the best page title for "<title> film"
//   2. REST summary      → lead extract + short description + canonical url
//   3. MediaWiki extracts → full plaintext, mined for the Reception section
// Calls 1+2 are required; call 3 is optional enrichment and never fails the
// source. Raw payloads are cached (7d) at the HTTP layer, so a thrown error
// is never persisted.
import { fetchCached } from "../http.js";
import type { RawSourceItem, RawSourceResult, ResearchQuery } from "../types.js";

const TTL = 7 * 24 * 60 * 60; // 7 days
const RECEPTION_RE = /reception|critical\s+(response|reception|reaction)/i;

interface WikiSearchResponse {
  query?: {
    search?: Array<{ title?: string; pageid?: number }>;
  };
}
interface WikiSummary {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}
interface WikiExtractResponse {
  query?: {
    pages?: Record<string, { title?: string; extract?: string }>;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function fail(error: unknown, cached?: boolean): RawSourceResult {
  return {
    source: "wikipedia",
    kind: "both",
    ok: false,
    items: [],
    error: error instanceof Error ? error.message : String(error),
    fetchedAt: nowIso(),
    ...(cached !== undefined ? { cached } : {}),
  };
}

/**
 * Split a plaintext article (exsectionformat=wiki, so headings look like
 * "== Heading ==") into its heading list, and capture the Reception /
 * Critical-response section body if one exists.
 */
function parseSections(plaintext: string): { headings: string[]; reception?: string } {
  const headingRe = /^(={2,6})\s*(.+?)\s*\1\s*$/;
  const lines = plaintext.split("\n");
  const headings: string[] = [];
  const buf: string[] = [];
  let capturing = false;
  let captureLevel = 0;

  for (const line of lines) {
    const m = line.match(headingRe);
    const eq = m?.[1];
    const headingText = m?.[2];
    if (m && eq && headingText) {
      const level = eq.length;
      const heading = headingText.trim();
      headings.push(heading);
      if (capturing && level <= captureLevel) {
        capturing = false;
      }
      if (!capturing && RECEPTION_RE.test(heading)) {
        capturing = true;
        captureLevel = level;
      }
      // Never push a heading line into the captured body.
      continue;
    }
    if (capturing) buf.push(line);
  }

  const text = buf.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text ? { headings, reception: text.slice(0, 4000) } : { headings };
}

async function queryWikipedia(q: ResearchQuery): Promise<RawSourceResult> {
  try {
    // 1. Search for the best page title.
    const term = `${q.title} film`;
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1" +
      `&srsearch=${encodeURIComponent(term)}`;
    const searchKey = `research:wikipedia:search:${q.title.toLowerCase()}`;
    const search = await fetchCached<WikiSearchResponse>(searchKey, searchUrl, { ttlSeconds: TTL });
    const pageTitle = search.value.query?.search?.[0]?.title;
    if (!pageTitle) {
      return fail(`no matching Wikipedia page for "${q.title}"`, search.cached);
    }

    // 2. REST summary for the lead extract + description + canonical url.
    const summaryUrl =
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(pageTitle);
    const summaryKey = `research:wikipedia:summary:${pageTitle}`;
    const summary = await fetchCached<WikiSummary>(summaryKey, summaryUrl, { ttlSeconds: TTL });

    // 3. Best-effort: full plaintext → section headings + Reception body.
    let reception: string | undefined;
    let sections: string[] | undefined;
    let extractCached = true;
    try {
      const extractUrl =
        "https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts" +
        "&explaintext=1&exsectionformat=wiki&redirects=1" +
        `&titles=${encodeURIComponent(pageTitle)}`;
      const extractKey = `research:wikipedia:extract:${pageTitle}`;
      const ex = await fetchCached<WikiExtractResponse>(extractKey, extractUrl, { ttlSeconds: TTL });
      extractCached = ex.cached;
      const pages = ex.value.query?.pages;
      const firstPage = pages ? Object.values(pages)[0] : undefined;
      const fullText = firstPage?.extract;
      if (fullText) {
        const parsed = parseSections(fullText);
        if (parsed.headings.length > 0) sections = parsed.headings;
        reception = parsed.reception;
      }
    } catch {
      // Reception is optional enrichment — swallow and continue.
    }

    const pageUrl =
      summary.value.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`;

    const meta: Record<string, unknown> = {};
    if (summary.value.description) meta.description = summary.value.description;
    if (sections) meta.sections = sections;
    if (reception) meta.reception = reception;

    const item: RawSourceItem = {
      title: summary.value.title ?? pageTitle,
      url: pageUrl,
      ...(summary.value.extract ? { snippet: summary.value.extract } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };

    return {
      source: "wikipedia",
      kind: "both",
      ok: true,
      items: [item],
      raw: summary.value,
      fetchedAt: nowIso(),
      cached: search.cached && summary.cached && extractCached,
    };
  } catch (err) {
    return fail(err);
  }
}

export const wikipedia = {
  name: "wikipedia",
  kind: "both",
  requiresKey: false,
  isAvailable: () => true,
  query: queryWikipedia,
} as const satisfies import("../types.js").ResearchSource;
