// scripts/movie-lookup/sources.ts
// Pluggable image/video/data source adapters for the internal movie-lookup tool.
//
// Each source is a small adapter behind a common interface. Endpoints aggregate
// across the registered adapters and dedupe, so a NEW source (Fanart.tv, TVDB, …)
// is added later by writing one adapter and pushing it into SOURCES — no endpoint
// change required. Each adapter call returns { items, raw } so the tool can show
// the complete unmodified source payload in its raw-JSON view.
//
// Currently registered: TMDb (movie images + person images + videos) and OMDb
// (movie poster). Wikipedia background lives in wiki.ts (a different source kind).
//
// READ-ONLY + no cache writes: these adapters do DIRECT, UNCACHED TMDb/OMDb GETs
// (they mirror the base URLs + env-var names the pipeline uses — TMDB_API_KEY /
// OMDB_API_KEY, read by name — but deliberately BYPASS shared/cache.ts so nothing
// is written to data/cache.sqlite). They never import shared/config.ts (which
// process.exit(1)s on missing NOTION/R2 keys); a missing OMDb key just yields [].

import { ofetch } from "ofetch";
import { mapLanguage } from "../../src/ingestion/releases/tmdb.js";

const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "http://www.omdbapi.com";
export const IMG_BASE = "https://image.tmdb.org/t/p/";

// ── Shared display helpers (used by lookup.ts too) ───────────────────────────
const LANG_DISPLAY: Record<string, string> = {
  hi: "Hindi", te: "Telugu", ta: "Tamil", ml: "Malayalam", kn: "Kannada",
  mr: "Marathi", bn: "Bengali", pa: "Punjabi", gu: "Gujarati", or: "Odia",
  as: "Assamese", ur: "Urdu", en: "English", ja: "Japanese", ko: "Korean",
  zh: "Chinese", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", ru: "Russian", ar: "Arabic", th: "Thai", fa: "Persian",
};

export function langName(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  return LANG_DISPLAY[iso.toLowerCase()] ?? mapLanguage(iso) ?? iso.toUpperCase();
}

export function img(path: string | null | undefined, size: string): string | undefined {
  return path ? `${IMG_BASE}${size}${path}` : undefined;
}

// ── Uncached low-level GETs (no cache.sqlite writes) ─────────────────────────
export async function tmdbGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("TMDB_API_KEY is not set");
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return ofetch<T>(url.toString(), { retry: 2, retryDelay: 500 });
}

export async function omdbGet(params: Record<string, string>): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return null; // OMDb optional — absent key ⇒ no OMDb contribution
  try {
    return await ofetch<Record<string, unknown>>(OMDB_BASE, {
      query: { apikey: apiKey, ...params },
      retry: 1,
      retryDelay: 400,
    });
  } catch {
    return null;
  }
}

// ── Common shapes ────────────────────────────────────────────────────────────
export interface ImageItem {
  source: string;                       // "tmdb" | "omdb" | future adapters
  kind: "poster" | "backdrop" | "profile";
  fullUrl: string;                      // full / original resolution
  thumbUrl: string;                     // grid thumbnail
  width?: number;
  height?: number;
  language?: string;                    // display name, or undefined = language-neutral
  voteAverage?: number;
}

export interface VideoItem {
  source: string;
  site: string;                         // "YouTube" | "Vimeo" | …
  key: string;                          // provider video key
  name: string;
  type: string;                         // Trailer | Teaser | Clip | Featurette | …
  official: boolean;
  url: string;                          // watch URL (opens in a new tab)
  thumbUrl?: string;                    // provider thumbnail if easy
  publishedAt?: string;
}

/** Every adapter call returns its items AND the raw source payload (for raw-JSON). */
export interface SourcePayload<T> { items: T[]; raw?: unknown; }

export interface MovieImageContext { tmdbId: number; imdbId?: string; }
export interface PersonImageContext { tmdbId: number; }

export interface SourceAdapter {
  name: string;
  getMovieImages(ctx: MovieImageContext): Promise<SourcePayload<ImageItem>>;
  getPersonImages(ctx: PersonImageContext): Promise<SourcePayload<ImageItem>>;
  getMovieVideos?(ctx: MovieImageContext): Promise<SourcePayload<VideoItem>>;
}

// ── TMDb response shapes we read ─────────────────────────────────────────────
interface TmdbImage {
  file_path: string;
  width: number;
  height: number;
  vote_average: number;
  iso_639_1: string | null;
}
interface TmdbMovieImages { id: number; posters?: TmdbImage[]; backdrops?: TmdbImage[]; }
interface TmdbPersonImages { id: number; profiles?: TmdbImage[]; }
interface TmdbVideo {
  id?: string; key: string; site: string; type: string; name: string;
  official?: boolean; published_at?: string;
}
interface TmdbVideosResponse { id: number; results?: TmdbVideo[]; }

const VIDEO_TYPE_RANK: Record<string, number> = { Trailer: 0, Teaser: 1, Clip: 2, Featurette: 3 };

// ── TMDb adapter ─────────────────────────────────────────────────────────────
export const tmdbSource: SourceAdapter = {
  name: "tmdb",
  async getMovieImages(ctx) {
    const res = await tmdbGet<TmdbMovieImages>(`/movie/${ctx.tmdbId}/images`, {
      // language-tagged art (Indian languages + English) PLUS language-neutral (null)
      include_image_language: "en,hi,te,ta,ml,kn,mr,bn,pa,null",
    });
    const posters = (res.posters ?? []).map((im): ImageItem => ({
      source: "tmdb", kind: "poster",
      fullUrl: `${IMG_BASE}original${im.file_path}`, thumbUrl: `${IMG_BASE}w342${im.file_path}`,
      width: im.width, height: im.height,
      ...(im.iso_639_1 ? { language: langName(im.iso_639_1) } : {}), voteAverage: im.vote_average,
    }));
    const backdrops = (res.backdrops ?? []).map((im): ImageItem => ({
      source: "tmdb", kind: "backdrop",
      fullUrl: `${IMG_BASE}original${im.file_path}`, thumbUrl: `${IMG_BASE}w780${im.file_path}`,
      width: im.width, height: im.height,
      ...(im.iso_639_1 ? { language: langName(im.iso_639_1) } : {}), voteAverage: im.vote_average,
    }));
    return { items: [...posters, ...backdrops], raw: res };
  },
  async getPersonImages(ctx) {
    const res = await tmdbGet<TmdbPersonImages>(`/person/${ctx.tmdbId}/images`, {});
    const items = (res.profiles ?? []).map((im): ImageItem => ({
      source: "tmdb", kind: "profile",
      fullUrl: `${IMG_BASE}original${im.file_path}`, thumbUrl: `${IMG_BASE}w185${im.file_path}`,
      width: im.width, height: im.height, voteAverage: im.vote_average,
    }));
    return { items, raw: res };
  },
  async getMovieVideos(ctx) {
    const res = await tmdbGet<TmdbVideosResponse>(`/movie/${ctx.tmdbId}/videos`, {});
    const items = (res.results ?? [])
      .filter((v) => v.key && v.site)
      .map((v): VideoItem => ({
        source: "tmdb",
        site: v.site,
        key: v.key,
        name: v.name,
        type: v.type,
        official: !!v.official,
        url: v.site === "YouTube"
          ? `https://www.youtube.com/watch?v=${v.key}`
          : v.site === "Vimeo" ? `https://vimeo.com/${v.key}` : v.key,
        ...(v.site === "YouTube" ? { thumbUrl: `https://img.youtube.com/vi/${v.key}/hqdefault.jpg` } : {}),
        ...(v.published_at ? { publishedAt: v.published_at } : {}),
      }))
      .sort((a, b) =>
        Number(b.official) - Number(a.official) ||
        (VIDEO_TYPE_RANK[a.type] ?? 9) - (VIDEO_TYPE_RANK[b.type] ?? 9) ||
        (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")
      );
    return { items, raw: res };
  },
};

// ── OMDb adapter ─────────────────────────────────────────────────────────────
// The existing omdb.ts DROPS the Poster field (fetchOmdbByImdbId → OmdbData has
// no poster), and editing it to expose Poster is forbidden. So this adapter does
// its own read-only OMDb GET by IMDb id to surface the single OMDb poster. OMDb
// has no person or video endpoint.
export const omdbSource: SourceAdapter = {
  name: "omdb",
  async getMovieImages(ctx) {
    if (!ctx.imdbId) return { items: [] };
    const raw = await omdbGet({ i: ctx.imdbId });
    const poster = raw?.["Poster"];
    if (typeof poster !== "string" || poster === "N/A" || !/^https?:\/\//.test(poster)) {
      return { items: [], raw };
    }
    return { items: [{ source: "omdb", kind: "poster", fullUrl: poster, thumbUrl: poster }], raw };
  },
  async getPersonImages() {
    return { items: [] }; // OMDb exposes no person images
  },
};

// ── Registry — push a new adapter here to add a source (no endpoint changes) ──
export const SOURCES: SourceAdapter[] = [tmdbSource, omdbSource];

/** Dedupe images by full URL (exported for tests). */
export function dedupeImages(items: ImageItem[]): ImageItem[] {
  const seen = new Set<string>();
  const out: ImageItem[] = [];
  for (const it of items) {
    if (seen.has(it.fullUrl)) continue;
    seen.add(it.fullUrl);
    out.push(it);
  }
  return out;
}

/** Dedupe videos by provider key (exported for tests). */
export function dedupeVideos(items: VideoItem[]): VideoItem[] {
  const seen = new Set<string>();
  const out: VideoItem[] = [];
  for (const it of items) {
    const k = `${it.site}:${it.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export interface Aggregated<T> { items: T[]; raw: Record<string, unknown>; sources: string[]; }

async function runAdapters<T>(
  call: (s: SourceAdapter) => Promise<SourcePayload<T>> | undefined,
  dedupeFn: (items: T[]) => T[]
): Promise<Aggregated<T>> {
  const settled = await Promise.allSettled(
    SOURCES.map(async (s) => {
      const p = call(s);
      return p ? { name: s.name, payload: await p } : null;
    })
  );
  const raw: Record<string, unknown> = {};
  const all: T[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled" || !r.value) continue;
    const { name, payload } = r.value;
    if (payload.raw !== undefined) raw[name] = payload.raw;
    all.push(...payload.items);
  }
  const items = dedupeFn(all);
  const sources = [...new Set((items as { source?: string }[]).map((i) => i.source).filter(Boolean) as string[])];
  return { items, raw, sources };
}

/** Aggregate movie images across all registered sources; one failing source
 *  never sinks the others. Deduped by full URL. */
export function aggregateMovieImages(ctx: MovieImageContext): Promise<Aggregated<ImageItem>> {
  return runAdapters<ImageItem>((s) => s.getMovieImages(ctx), dedupeImages);
}

/** Aggregate person images across all registered sources. Deduped by full URL. */
export function aggregatePersonImages(ctx: PersonImageContext): Promise<Aggregated<ImageItem>> {
  return runAdapters<ImageItem>((s) => s.getPersonImages(ctx), dedupeImages);
}

/** Aggregate movie videos across sources that expose them. Deduped by key. */
export function aggregateMovieVideos(ctx: MovieImageContext): Promise<Aggregated<VideoItem>> {
  return runAdapters<VideoItem>((s) => s.getMovieVideos?.(ctx), dedupeVideos);
}
