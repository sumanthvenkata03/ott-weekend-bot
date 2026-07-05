// scripts/movie-lookup/sources.ts
// Pluggable image/data source adapters for the internal movie-lookup tool.
//
// Each source is a small adapter with a common interface. Endpoints aggregate
// across the registered adapters and dedupe, so a NEW source (Fanart.tv, TVDB,
// …) is added later by writing one adapter and pushing it into IMAGE_SOURCES —
// no endpoint change required.
//
// Currently registered: TMDb (movie + person images) and OMDb (movie poster).
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

export interface MovieImageContext { tmdbId: number; imdbId?: string; }
export interface PersonImageContext { tmdbId: number; }

export interface ImageSourceAdapter {
  name: string;
  getMovieImages(ctx: MovieImageContext): Promise<ImageItem[]>;
  getPersonImages(ctx: PersonImageContext): Promise<ImageItem[]>;
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

// ── TMDb adapter ─────────────────────────────────────────────────────────────
export const tmdbImageSource: ImageSourceAdapter = {
  name: "tmdb",
  async getMovieImages(ctx) {
    const res = await tmdbGet<TmdbMovieImages>(`/movie/${ctx.tmdbId}/images`, {
      // language-tagged art (Indian languages + English) PLUS language-neutral (null)
      include_image_language: "en,hi,te,ta,ml,kn,mr,bn,pa,null",
    });
    const posters = (res.posters ?? []).map((im): ImageItem => ({
      source: "tmdb",
      kind: "poster",
      fullUrl: `${IMG_BASE}original${im.file_path}`,
      thumbUrl: `${IMG_BASE}w342${im.file_path}`,
      width: im.width,
      height: im.height,
      ...(im.iso_639_1 ? { language: langName(im.iso_639_1) } : {}),
      voteAverage: im.vote_average,
    }));
    const backdrops = (res.backdrops ?? []).map((im): ImageItem => ({
      source: "tmdb",
      kind: "backdrop",
      fullUrl: `${IMG_BASE}original${im.file_path}`,
      thumbUrl: `${IMG_BASE}w780${im.file_path}`,
      width: im.width,
      height: im.height,
      ...(im.iso_639_1 ? { language: langName(im.iso_639_1) } : {}),
      voteAverage: im.vote_average,
    }));
    return [...posters, ...backdrops];
  },
  async getPersonImages(ctx) {
    const res = await tmdbGet<TmdbPersonImages>(`/person/${ctx.tmdbId}/images`, {});
    return (res.profiles ?? []).map((im): ImageItem => ({
      source: "tmdb",
      kind: "profile",
      fullUrl: `${IMG_BASE}original${im.file_path}`,
      thumbUrl: `${IMG_BASE}w185${im.file_path}`,
      width: im.width,
      height: im.height,
      voteAverage: im.vote_average,
    }));
  },
};

// ── OMDb adapter ─────────────────────────────────────────────────────────────
// The existing omdb.ts DROPS the Poster field (fetchOmdbByImdbId → OmdbData has
// no poster), and editing it to expose Poster is forbidden. So this adapter does
// its own read-only OMDb GET by IMDb id to surface the single OMDb poster. OMDb
// has no person endpoint ⇒ getPersonImages returns [].
export const omdbImageSource: ImageSourceAdapter = {
  name: "omdb",
  async getMovieImages(ctx) {
    if (!ctx.imdbId) return [];
    const raw = await omdbGet({ i: ctx.imdbId });
    const poster = raw?.["Poster"];
    if (typeof poster !== "string" || poster === "N/A" || !/^https?:\/\//.test(poster)) return [];
    return [{
      source: "omdb",
      kind: "poster",
      fullUrl: poster,
      thumbUrl: poster,
    }];
  },
  async getPersonImages() {
    return []; // OMDb exposes no person images
  },
};

// ── Registry — push a new adapter here to add a source (no endpoint changes) ──
export const IMAGE_SOURCES: ImageSourceAdapter[] = [tmdbImageSource, omdbImageSource];

function dedupe(items: ImageItem[]): ImageItem[] {
  const seen = new Set<string>();
  const out: ImageItem[] = [];
  for (const it of items) {
    if (seen.has(it.fullUrl)) continue;
    seen.add(it.fullUrl);
    out.push(it);
  }
  return out;
}

/** Aggregate movie images across all registered sources; one failing source
 *  never sinks the others (Promise.allSettled). Deduped by full URL. */
export async function aggregateMovieImages(ctx: MovieImageContext): Promise<ImageItem[]> {
  const settled = await Promise.allSettled(IMAGE_SOURCES.map((s) => s.getMovieImages(ctx)));
  return dedupe(settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
}

/** Aggregate person images across all registered sources. Deduped by full URL. */
export async function aggregatePersonImages(ctx: PersonImageContext): Promise<ImageItem[]> {
  const settled = await Promise.allSettled(IMAGE_SOURCES.map((s) => s.getPersonImages(ctx)));
  return dedupe(settled.flatMap((r) => (r.status === "fulfilled" ? r.value : [])));
}

/** Which registered sources actually contributed, for UI/debug. */
export function contributingSources(items: ImageItem[]): string[] {
  return [...new Set(items.map((i) => i.source))];
}
