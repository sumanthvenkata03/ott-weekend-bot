// src/research/sources/youtube.ts
// Keyed signal source. Uses the official-trailer view count as a
// discoverability proxy via the YouTube Data API v3, in two cached calls:
//   1. search.list  (100 quota units) — up to 5 candidate trailer videos
//   2. videos.list  (1 quota unit)    — real statistics for those video ids
// Both are cached (24h) under research:youtube:* keys so re-runs cost zero
// quota. Reads YOUTUBE_API_KEY from process.env directly (never the eager
// config) so the standalone CLI keeps working.
import { fetchCached } from "../http.js";
import type { RawSourceItem, RawSourceResult, ResearchQuery } from "../types.js";

const YT_TTL = 24 * 60 * 60; // 24h — trailer view counts drift slowly; tunable
const MAX_RESULTS = 5;
const SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

interface YtSearchItem {
  id?: { videoId?: string };
}
interface YtSearchResponse {
  items?: YtSearchItem[];
}
interface YtVideoItem {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    publishedAt?: string;
  };
  statistics?: {
    viewCount?: string;
  };
}
interface YtVideosResponse {
  items?: YtVideoItem[];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Deterministic thousands separators (no ICU/locale dependency). */
function formatThousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** The API key rides in the request URL, so strip it from any error string. */
function redactKey(msg: string): string {
  return msg.replace(/key=[^&"\s]+/g, "key=***");
}

function fail(error: unknown): RawSourceResult {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    source: "youtube",
    kind: "signal",
    ok: false,
    items: [],
    error: redactKey(msg),
    fetchedAt: nowIso(),
  };
}

function isAvailable(): boolean {
  return !!process.env.YOUTUBE_API_KEY;
}

async function queryYouTube(q: ResearchQuery): Promise<RawSourceResult> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return fail("YOUTUBE_API_KEY not set");

  try {
    // 1. search.list — candidate trailer videos (100 units).
    const searchTerm = `"${q.title}"${q.year ? ` ${q.year}` : ""} trailer`;
    const searchUrl = new URL(SEARCH_URL);
    searchUrl.searchParams.set("part", "snippet");
    searchUrl.searchParams.set("type", "video");
    searchUrl.searchParams.set("order", "relevance");
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    searchUrl.searchParams.set("q", searchTerm);
    searchUrl.searchParams.set("key", apiKey);
    const searchKey = `research:youtube:search:${q.title.toLowerCase()}:${q.year ?? ""}`;
    const search = await fetchCached<YtSearchResponse>(searchKey, searchUrl.toString(), {
      ttlSeconds: YT_TTL,
    });

    const videoIds = (search.value.items ?? [])
      .map((it) => it.id?.videoId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    // Search succeeded but matched nothing — a valid empty result, not an error.
    if (videoIds.length === 0) {
      return {
        source: "youtube",
        kind: "signal",
        ok: true,
        items: [],
        raw: search.value,
        fetchedAt: nowIso(),
        cached: search.cached,
      };
    }

    // 2. videos.list — real statistics for those ids (1 unit). Distinct cache
    // key (call-type + the actual ids) so it never collides with search.list.
    const videosUrl = new URL(VIDEOS_URL);
    videosUrl.searchParams.set("part", "statistics,snippet");
    videosUrl.searchParams.set("id", videoIds.join(","));
    videosUrl.searchParams.set("key", apiKey);
    const videosKey = `research:youtube:videos:${videoIds.join(",")}`;
    const videos = await fetchCached<YtVideosResponse>(videosKey, videosUrl.toString(), {
      ttlSeconds: YT_TTL,
    });

    // Coerce missing/hidden viewCount to 0 so it never becomes NaN and poisons
    // the sort or the max.
    const ranked = (videos.value.items ?? [])
      .map((v) => ({ v, viewCount: Number(v.statistics?.viewCount ?? 0) || 0 }))
      .sort((a, b) => b.viewCount - a.viewCount);

    const items: RawSourceItem[] = ranked.map(({ v, viewCount }) => {
      const channelTitle = v.snippet?.channelTitle;
      const title = v.snippet?.title;
      const human = `${formatThousands(viewCount)} views${channelTitle ? ` · ${channelTitle}` : ""}`;
      return {
        ...(title ? { title } : {}),
        ...(v.id ? { url: `https://www.youtube.com/watch?v=${v.id}` } : {}),
        ...(v.snippet?.publishedAt ? { publishedAt: v.snippet.publishedAt } : {}),
        // viewCount lives structured in meta AND prepended into snippet so a
        // downstream LLM reads it either way.
        snippet: title ? `${human} — ${title}` : human,
        meta: {
          viewCount,
          ...(channelTitle ? { channelTitle } : {}),
          ...(v.id ? { videoId: v.id } : {}),
        },
      };
    });

    const maxViewCount = ranked[0]?.viewCount ?? 0;

    return {
      source: "youtube",
      kind: "signal",
      ok: true,
      items,
      raw: videos.value,
      meta: { maxViewCount },
      fetchedAt: nowIso(),
      cached: search.cached && videos.cached,
    };
  } catch (err) {
    return fail(err);
  }
}

export const youtube = {
  name: "youtube",
  kind: "signal",
  requiresKey: true,
  isAvailable,
  query: queryYouTube,
} as const satisfies import("../types.js").ResearchSource;
