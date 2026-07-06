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
import { overlapRatio } from "./wiki.js";

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
  source: string;                       // "tmdb" | "omdb" | "wikidata" | "wikipedia:ta" | …
  kind: "poster" | "backdrop" | "profile" | "still";
  fullUrl: string;                      // full / original resolution
  thumbUrl: string;                     // grid thumbnail
  width?: number;
  height?: number;
  language?: string;                    // display name, or undefined = language-neutral
  voteAverage?: number;
  context?: string;                     // e.g. the film title for a harvested "still"
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
  channel?: string;                     // e.g. YouTube channel title
}

/** Every adapter call returns its items AND the raw source payload (for raw-JSON). */
export interface SourcePayload<T> { items: T[]; raw?: unknown; }

export interface MovieImageContext { tmdbId: number; imdbId?: string; title?: string; year?: number; }
// Person identity for cross-source image lookup. tmdbId is always present; the
// other ids/name let the keyless (Wikidata/Commons/Wikipedia) and keyed (TVDB)
// person-image adapters resolve the same human.
export interface PersonImageContext { tmdbId: number; name?: string; imdbId?: string; wikidataId?: string; }

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

// ── Fanart.tv adapter (NEW KEY: FANART_API_KEY) ──────────────────────────────
// Full-res movie art keyed by TMDb (or IMDb) id. Graceful when the key is unset.
const FANART_BASE = "https://webservice.fanart.tv/v3/movies/";
interface FanartArt { id?: string; url: string; lang?: string; likes?: string; }
interface FanartResponse {
  movieposter?: FanartArt[]; moviebackground?: FanartArt[]; moviethumb?: FanartArt[];
  moviebanner?: FanartArt[]; hdmovielogo?: FanartArt[]; movielogo?: FanartArt[];
}
export const fanartSource: SourceAdapter = {
  name: "fanart",
  async getMovieImages(ctx) {
    const key = process.env.FANART_API_KEY;
    if (!key) return { items: [] };                       // graceful: no key ⇒ nothing
    const id = ctx.tmdbId || ctx.imdbId;
    if (!id) return { items: [] };
    let raw: FanartResponse;
    try {
      raw = await ofetch<FanartResponse>(`${FANART_BASE}${id}`, { query: { api_key: key }, retry: 1 });
    } catch { return { items: [] }; }                     // 404 (no art) ⇒ empty, no crash
    const mk = (a: FanartArt, kind: ImageItem["kind"]): ImageItem => ({
      source: "fanart", kind,
      fullUrl: a.url, thumbUrl: a.url,
      ...(a.lang && a.lang !== "00" ? { language: langName(a.lang) } : {}),
      ...(a.likes ? { voteAverage: Number(a.likes) } : {}),
    });
    const items = [
      ...(raw.movieposter ?? []).map((a) => mk(a, "poster")),
      ...(raw.moviebackground ?? []).map((a) => mk(a, "backdrop")),
      ...(raw.moviethumb ?? []).map((a) => mk(a, "backdrop")),
    ].filter((i) => typeof i.fullUrl === "string" && /^https?:\/\//.test(i.fullUrl));
    return { items, raw };
  },
  async getPersonImages() { return { items: [] }; },
};

// ── TVDB adapter (NEW KEY: TVDB_API_KEY) ─────────────────────────────────────
// TVDB v4 needs a login token exchange, then remoteid → movie → artworks. Graceful
// when the key is unset or the film isn't in TVDB. Token cached in-memory.
const TVDB_BASE = "https://api4.thetvdb.com/v4";
let tvdbToken: string | null = null;
async function tvdbLogin(): Promise<string | null> {
  const key = process.env.TVDB_API_KEY;
  if (!key) return null;
  if (tvdbToken) return tvdbToken;
  try {
    const res = await ofetch<{ data?: { token?: string } }>(`${TVDB_BASE}/login`, {
      method: "POST", body: { apikey: key }, headers: { Accept: "application/json" }, retry: 1,
    });
    tvdbToken = res.data?.token ?? null;
    return tvdbToken;
  } catch { return null; }
}
interface TvdbArtwork { image?: string; thumbnail?: string; language?: string | null; width?: number; height?: number; score?: number; }
export const tvdbSource: SourceAdapter = {
  name: "tvdb",
  async getMovieImages(ctx) {
    if (!ctx.imdbId) return { items: [] };                 // remoteid lookup needs IMDb id
    const token = await tvdbLogin();
    if (!token) return { items: [] };                      // graceful: no key / login fail
    const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    try {
      const remote = await ofetch<{ data?: { movie?: { id?: number } }[] }>(
        `${TVDB_BASE}/search/remoteid/${encodeURIComponent(ctx.imdbId)}`, { headers: auth, retry: 1 }
      );
      const movieId = remote.data?.map((d) => d.movie?.id).find((x) => typeof x === "number");
      if (!movieId) return { items: [], raw: remote };
      const ext = await ofetch<{ data?: { artworks?: TvdbArtwork[] } }>(
        `${TVDB_BASE}/movies/${movieId}/extended`, { headers: auth, retry: 1 }
      );
      const arts = ext.data?.artworks ?? [];
      const items = arts
        .filter((a) => a.image && /^https?:\/\//.test(a.image))
        .map((a): ImageItem => {
          const portrait = a.width && a.height ? a.height > a.width : false;
          return {
            source: "tvdb", kind: portrait ? "poster" : "backdrop",
            fullUrl: a.image!, thumbUrl: a.thumbnail || a.image!,
            ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}),
            ...(a.language ? { language: langName(a.language) } : {}),
            ...(a.score ? { voteAverage: a.score } : {}),
          };
        });
      return { items, raw: ext.data };
    } catch { return { items: [] }; }
  },
  // TVDB v4 has people records with images. Search people by name → extended
  // record → image + artworks. Graceful when no key / not found.
  async getPersonImages(ctx) {
    if (!ctx.name) return { items: [] };
    const token = await tvdbLogin();
    if (!token) return { items: [] };
    const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    try {
      const search = await ofetch<{ data?: { tvdb_id?: string; id?: string; image_url?: string }[] }>(
        `${TVDB_BASE}/search`, { query: { query: ctx.name, type: "people", limit: "5" }, headers: auth, retry: 1 }
      );
      const first = (search.data ?? []).find((p) => p.tvdb_id || p.id);
      if (!first) return { items: [], raw: search };
      const pid = first.tvdb_id ?? first.id;
      const ext = await ofetch<{ data?: { image?: string; artworks?: TvdbArtwork[] } }>(
        `${TVDB_BASE}/people/${pid}/extended`, { headers: auth, retry: 1 }
      );
      const rec = ext.data ?? {};
      const urls: { url: string; thumb?: string; w?: number; h?: number }[] = [];
      if (first.image_url && /^https?:\/\//.test(first.image_url)) urls.push({ url: first.image_url });
      if (rec.image && /^https?:\/\//.test(rec.image)) urls.push({ url: rec.image });
      for (const a of rec.artworks ?? []) {
        if (a.image && /^https?:\/\//.test(a.image)) urls.push({ url: a.image, thumb: a.thumbnail, w: a.width, h: a.height });
      }
      const items = urls.map((u): ImageItem => ({
        source: "tvdb", kind: "profile", fullUrl: u.url, thumbUrl: u.thumb || u.url,
        ...(u.w ? { width: u.w } : {}), ...(u.h ? { height: u.h } : {}),
      }));
      return { items, raw: ext.data };
    } catch { return { items: [] }; }
  },
};

// ── YouTube Data API adapter (NEW KEY: YOUTUBE_API_KEY) ───────────────────────
// Genuine YouTube links via the official Data API search (no scraping). Graceful
// when the key is unset. Merged + deduped (by site:key) with TMDb /videos.
const YOUTUBE_SEARCH = "https://www.googleapis.com/youtube/v3/search";
interface YtItem {
  id?: { videoId?: string };
  snippet?: { title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: { medium?: { url?: string }; high?: { url?: string } } };
}
export const youtubeSource: SourceAdapter = {
  name: "youtube",
  async getMovieImages() { return { items: [] }; },
  async getPersonImages() { return { items: [] }; },
  async getMovieVideos(ctx) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key || !ctx.title) return { items: [] };          // graceful: no key or no title
    const q = `${ctx.title}${ctx.year ? " " + ctx.year : ""} trailer`;
    let raw: { items?: YtItem[] };
    try {
      raw = await ofetch<{ items?: YtItem[] }>(YOUTUBE_SEARCH, {
        query: { part: "snippet", type: "video", maxResults: "8", q, key }, retry: 1,
      });
    } catch { return { items: [] }; }
    const items = (raw.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it): VideoItem => {
        const t = it.snippet?.title ?? "";
        const ch = it.snippet?.channelTitle ?? "";
        const type = /teaser/i.test(t) ? "Teaser" : /clip/i.test(t) ? "Clip" : "Trailer";
        return {
          source: "youtube", site: "YouTube", key: it.id!.videoId!,
          name: t, type,
          official: /official/i.test(ch) || /official/i.test(t),
          url: `https://www.youtube.com/watch?v=${it.id!.videoId}`,
          ...(it.snippet?.thumbnails?.medium?.url ? { thumbUrl: it.snippet.thumbnails.medium.url } : {}),
          ...(it.snippet?.publishedAt ? { publishedAt: it.snippet.publishedAt } : {}),
          channel: ch,
        };
      });
    return { items, raw };
  },
};

// ── Wikidata + Wikimedia Commons person images (NO KEY) ──────────────────────
// The highest-value keyless person source. Resolve the human to a Wikidata QID
// (from TMDb external_ids wikidata_id, else via IMDb id P345), read the image
// claim P18 and the Commons category P373, then pull direct full-res URLs via the
// Commons imageinfo API. Freely-licensed, usually MANY photos.
const WD_API = "https://www.wikidata.org/w/api.php";
const WD_SPARQL = "https://query.wikidata.org/sparql";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const WIKI_UA = "TBSI-movie-lookup/1.0 (internal reference tool)";
const COMMONS_MAX_FILES = Number.parseInt(process.env.MOVIE_LOOKUP_COMMONS_MAX ?? "60", 10) || 60;

// Wikimedia (Wikidata/Commons/Wikipedia) rate-limits aggressive parallelism. The
// person-image fan-out can fire ~15 Wikimedia calls at once (entity + sitelinks +
// commons category/subcats/imageinfo + several language summaries), which triggers
// 429s and silently drops images. Gate ALL Wikimedia requests through a small
// concurrency limiter so they stay polite and reliable, regardless of caller.
const WM_CONCURRENCY = Number.parseInt(process.env.MOVIE_LOOKUP_WM_CONCURRENCY ?? "1", 10) || 1;
let wmActive = 0;
const wmWaiters: (() => void)[] = [];
async function wmFetch<T>(url: string, opts: Parameters<typeof ofetch>[1]): Promise<T> {
  if (wmActive >= WM_CONCURRENCY) await new Promise<void>((res) => wmWaiters.push(res));
  wmActive++;
  try {
    // Force strong retry/backoff on ALL Wikimedia calls (overrides any per-call
    // retry) so a transient 429 under load recovers instead of dropping images.
    return await ofetch<T>(url, { ...opts, retry: 3, retryDelay: 600 });
  } finally {
    wmActive--;
    const w = wmWaiters.shift();
    if (w) w();
  }
}
// Language Wikipedias to try for a person's lead image (via Wikidata sitelinks).
const WIKI_LANGS = (process.env.MOVIE_LOOKUP_WIKI_LANGS ?? "en,ta,te,hi,ml,kn,bn,mr")
  .split(",").map((s) => s.trim()).filter(Boolean);

interface WdClaimSnak { mainsnak?: { datavalue?: { value?: unknown } } }
interface WdEntity { claims?: Record<string, WdClaimSnak[]> }

/** P18 image-claim Commons filenames (exported, pure — for tests). */
export function extractWikidataImages(entity: WdEntity | null | undefined): string[] {
  const out: string[] = [];
  for (const c of entity?.claims?.["P18"] ?? []) {
    const v = c?.mainsnak?.datavalue?.value;
    if (typeof v === "string") out.push(v);
  }
  return out;
}
/** P373 Commons category (exported, pure — for tests). */
export function extractCommonsCategory(entity: WdEntity | null | undefined): string | undefined {
  const v = entity?.claims?.["P373"]?.[0]?.mainsnak?.datavalue?.value;
  return typeof v === "string" ? v : undefined;
}

async function wikidataIdFromImdb(imdbId: string): Promise<string | undefined> {
  try {
    const res = await wmFetch<{ results?: { bindings?: { item?: { value?: string } }[] } }>(WD_SPARQL, {
      query: { query: `SELECT ?item WHERE { ?item wdt:P345 "${imdbId}" } LIMIT 1`, format: "json" },
      headers: { "User-Agent": WIKI_UA, Accept: "application/sparql-results+json" }, retry: 1,
    });
    const uri = res.results?.bindings?.[0]?.item?.value; // …/entity/Q123
    return uri ? uri.split("/").pop() : undefined;
  } catch { return undefined; }
}
async function wdGetEntity(qid: string): Promise<WdEntity | null> {
  try {
    const res = await wmFetch<{ entities?: Record<string, WdEntity> }>(WD_API, {
      query: { action: "wbgetentities", ids: qid, props: "claims", format: "json", origin: "*" },
      headers: { "User-Agent": WIKI_UA }, retry: 1,
    });
    return res.entities?.[qid] ?? null;
  } catch { return null; }
}
async function commonsCategoryFiles(category: string, limit = 25): Promise<string[]> {
  try {
    const res = await wmFetch<{ query?: { categorymembers?: { title?: string }[] } }>(COMMONS_API, {
      query: { action: "query", list: "categorymembers", cmtitle: `Category:${category}`, cmtype: "file", cmlimit: String(limit), format: "json", origin: "*" },
      headers: { "User-Agent": WIKI_UA }, retry: 1,
    });
    return (res.query?.categorymembers ?? []).map((m) => m.title).filter((t): t is string => !!t && /\.(jpe?g|png)$/i.test(t));
  } catch { return []; }
}
async function commonsSubcategories(category: string, limit = 12): Promise<string[]> {
  try {
    const res = await wmFetch<{ query?: { categorymembers?: { title?: string }[] } }>(COMMONS_API, {
      query: { action: "query", list: "categorymembers", cmtitle: `Category:${category}`, cmtype: "subcat", cmlimit: String(limit), format: "json", origin: "*" },
      headers: { "User-Agent": WIKI_UA }, retry: 1,
    });
    return (res.query?.categorymembers ?? []).map((m) => m.title?.replace(/^Category:/, "")).filter((t): t is string => !!t);
  } catch { return []; }
}
/** Deeper Commons traversal: files in the category PLUS files from one level of
 *  subcategories (e.g. "Samantha in 2019"), bounded to `maxFiles` total. */
async function commonsCategoryDeep(category: string, maxFiles = 60): Promise<string[]> {
  const seen = new Set<string>();
  const push = (arr: string[]) => { for (const t of arr) { if (seen.size >= maxFiles) break; seen.add(t); } };
  push(await commonsCategoryFiles(category, 40));
  if (seen.size < maxFiles) {
    const subs = await commonsSubcategories(category);
    const subFiles = await Promise.all(subs.map((s) => commonsCategoryFiles(s, 20)));
    for (const f of subFiles) { push(f); if (seen.size >= maxFiles) break; }
  }
  return [...seen];
}
interface CommonsInfo { url: string; thumb?: string; w?: number; h?: number; }
async function commonsImageInfo(fileTitles: string[]): Promise<CommonsInfo[]> {
  const out: CommonsInfo[] = [];
  for (let i = 0; i < fileTitles.length; i += 40) {
    const batch = fileTitles.slice(i, i + 40);
    if (!batch.length) continue;
    try {
      const res = await wmFetch<{ query?: { pages?: Record<string, { imageinfo?: { url?: string; thumburl?: string; width?: number; height?: number }[] }> } }>(COMMONS_API, {
        query: { action: "query", titles: batch.join("|"), prop: "imageinfo", iiprop: "url|size", iiurlwidth: "360", format: "json", origin: "*" },
        headers: { "User-Agent": WIKI_UA }, retry: 1,
      });
      for (const p of Object.values(res.query?.pages ?? {})) {
        const ii = p.imageinfo?.[0];
        if (ii?.url) out.push({ url: ii.url, ...(ii.thumburl ? { thumb: ii.thumburl } : {}), ...(ii.width ? { w: ii.width } : {}), ...(ii.height ? { h: ii.height } : {}) });
      }
    } catch { /* skip batch */ }
  }
  return out;
}

export const wikidataSource: SourceAdapter = {
  name: "wikidata",
  async getMovieImages() { return { items: [] }; },
  async getPersonImages(ctx) {
    let qid = ctx.wikidataId;
    if (!qid && ctx.imdbId) qid = await wikidataIdFromImdb(ctx.imdbId);
    if (!qid) return { items: [] };                          // graceful: can't resolve
    const entity = await wdGetEntity(qid);
    if (!entity) return { items: [], raw: { qid } };
    const p18 = extractWikidataImages(entity).map((f) => `File:${f.replace(/ /g, "_")}`);
    const category = extractCommonsCategory(entity);
    // Deeper traversal: category files + one level of subcategory files.
    const catFiles = category ? await commonsCategoryDeep(category, COMMONS_MAX_FILES) : [];
    const titles = [...new Set([...p18, ...catFiles])];
    const infos = await commonsImageInfo(titles);
    const items = infos.map((inf): ImageItem => ({
      source: "wikidata", kind: "profile", fullUrl: inf.url, thumbUrl: inf.thumb ?? inf.url,
      ...(inf.w ? { width: inf.w } : {}), ...(inf.h ? { height: inf.h } : {}),
    }));
    return { items, raw: { qid, p18, category, commonsCount: infos.length } };
  },
};

// ── Wikipedia lead image (NO KEY) ─────────────────────────────────────────────
// The person's article lead/original image, confidence-guarded by name overlap so
// a wrong-person photo never attaches. A name like "Sneha" resolves to a
// disambiguation page, so we FALL BACK to the search API to find the right
// "…(actress/actor)" article. Deduped by URL against Commons (same host).
const WIKI_REST_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKI_API_ACTION = "https://en.wikipedia.org/w/api.php";
interface WikiSummaryImg { type?: string; title?: string; originalimage?: { source?: string; width?: number; height?: number }; thumbnail?: { source?: string } }

async function wikiSummaryByTitle(title: string): Promise<WikiSummaryImg | null> {
  try {
    return await wmFetch<WikiSummaryImg>(WIKI_REST_SUMMARY + encodeURIComponent(title.replace(/ /g, "_")), {
      headers: { "User-Agent": WIKI_UA, Accept: "application/json" }, retry: 1,
    });
  } catch { return null; }
}
/** Disambiguation fallback: search for the person and pick the best article
 *  title (name overlap, with a bonus for an "(actress)"/"(actor)" article). */
async function wikiResolvePersonTitle(name: string): Promise<string | undefined> {
  try {
    const res = await wmFetch<{ query?: { search?: { title?: string }[] } }>(WIKI_API_ACTION, {
      query: { action: "query", list: "search", srsearch: `${name} actor actress film`, srlimit: "6", format: "json", origin: "*" },
      headers: { "User-Agent": WIKI_UA }, retry: 1,
    });
    const ranked = (res.query?.search ?? [])
      .map((h) => {
        let s = overlapRatio(name, h.title ?? "");
        if (/\((actress|actor)\)/i.test(h.title ?? "")) s += 0.3;
        return { title: h.title, score: s };
      })
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    return best && best.score >= 0.5 ? best.title : undefined;
  } catch { return undefined; }
}

function wikiImageFrom(res: WikiSummaryImg | null, name: string): ImageItem | null {
  if (!res || res.type === "disambiguation") return null;
  if (overlapRatio(name, res.title ?? "") < 0.5) return null; // wrong-person guard
  const orig = res.originalimage?.source;
  const thumb = res.thumbnail?.source;
  const url = orig ?? thumb;
  if (!url) return null;
  return {
    source: "wikipedia", kind: "profile", fullUrl: url, thumbUrl: thumb ?? url,
    ...(res.originalimage?.width ? { width: res.originalimage.width } : {}),
    ...(res.originalimage?.height ? { height: res.originalimage.height } : {}),
  };
}

export const wikipediaPersonSource: SourceAdapter = {
  name: "wikipedia",
  async getMovieImages() { return { items: [] }; },
  async getPersonImages(ctx) {
    if (!ctx.name) return { items: [] };
    // 1) direct title
    let summary = await wikiSummaryByTitle(ctx.name);
    let item = wikiImageFrom(summary, ctx.name);
    // 2) disambiguation / miss → search for the right article, then retry
    if (!item) {
      const resolved = await wikiResolvePersonTitle(ctx.name);
      if (resolved) { summary = await wikiSummaryByTitle(resolved); item = wikiImageFrom(summary, ctx.name); }
    }
    return item ? { items: [item], raw: summary } : { items: [], raw: summary };
  },
};

// ── Other-language Wikipedia lead images (NO KEY) ─────────────────────────────
// A person's article on ta/te/hi/ml/kn/… Wikipedias often has a DIFFERENT lead
// image than English (or exists where English doesn't). We resolve the exact
// per-language article titles via Wikidata SITELINKS (same entity ⇒ no wrong-
// person risk), then pull each lang article's lead image. Deduped by URL, so a
// lang that reuses the same Commons photo adds nothing.
async function wdSitelinks(qid: string): Promise<Record<string, string>> {
  try {
    const res = await wmFetch<{ entities?: Record<string, { sitelinks?: Record<string, { title?: string }> }> }>(WD_API, {
      query: { action: "wbgetentities", ids: qid, props: "sitelinks", format: "json", origin: "*" },
      headers: { "User-Agent": WIKI_UA }, retry: 1,
    });
    const sl = res.entities?.[qid]?.sitelinks ?? {};
    const out: Record<string, string> = {};
    for (const lang of WIKI_LANGS) { const t = sl[`${lang}wiki`]?.title; if (t) out[lang] = t; }
    return out;
  } catch { return {}; }
}
async function langWikiImage(lang: string, title: string): Promise<ImageItem | null> {
  try {
    const res = await wmFetch<WikiSummaryImg>(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      { headers: { "User-Agent": WIKI_UA, Accept: "application/json" }, retry: 1 }
    );
    const url = res.originalimage?.source ?? res.thumbnail?.source;
    if (!url) return null;
    return {
      source: `wikipedia:${lang}`, kind: "profile", fullUrl: url, thumbUrl: res.thumbnail?.source ?? url,
      ...(res.originalimage?.width ? { width: res.originalimage.width } : {}),
      ...(res.originalimage?.height ? { height: res.originalimage.height } : {}),
    };
  } catch { return null; }
}
export const wikipediaLangSource: SourceAdapter = {
  name: "wikipedia-langs",
  async getMovieImages() { return { items: [] }; },
  async getPersonImages(ctx) {
    let qid = ctx.wikidataId;
    if (!qid && ctx.imdbId) qid = await wikidataIdFromImdb(ctx.imdbId);
    if (!qid) return { items: [] };
    const sitelinks = await wdSitelinks(qid);
    const langs = Object.keys(sitelinks);
    if (!langs.length) return { items: [], raw: { qid, sitelinks } };
    const imgs = await Promise.all(langs.map((l) => langWikiImage(l, sitelinks[l]!)));
    const items = imgs.filter((x): x is ImageItem => !!x);
    return { items, raw: { qid, sitelinks, count: items.length } };
  },
};

// ── Registry — push a new adapter here to add a source (no endpoint changes) ──
// (Fanart.tv has NO actor/person image endpoint — only movie/tv/music — so it
// contributes nothing for people; its getPersonImages returns empty, by design.)
export const SOURCES: SourceAdapter[] = [
  tmdbSource, omdbSource, fanartSource, tvdbSource, youtubeSource,
  wikidataSource, wikipediaPersonSource, wikipediaLangSource,
];

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
