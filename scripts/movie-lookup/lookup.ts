// scripts/movie-lookup/lookup.ts
// Composition layer for the standalone internal "movie lookup" tool.
//
// Reuses the pipeline's discovery/resolution code read-only:
//   - searchTitleTmdb        (name -> candidate films)                 [reuse]
//   - getCreditsAndLanguages (audio langs / release dates / composer)  [reuse]
//   - getStreamingPlatforms  (OTT availability via JustWatch)          [reuse]
// and the tool-local, UNCACHED source adapters (sources.ts) for every image /
// person / raw call, so the detail flow writes NOTHING to data/cache.sqlite.
//
// No import of shared/config.ts (process.exit on missing NOTION/R2) and no import
// of omdb.ts/mdblist.ts. Importable with only TMDB_API_KEY set; OMDb is optional.

import {
  getCreditsAndLanguages,
  getStreamingPlatforms,
} from "../../src/ingestion/releases/tmdb.js";
import {
  tmdbGet,
  omdbGet,
  aggregateMovieImages,
  aggregatePersonImages,
  aggregateMovieVideos,
  img,
  langName,
  type ImageItem,
  type VideoItem,
} from "./sources.js";
import { aggregateBackground, type BackgroundResult } from "./wiki.js";

// ── TMDb response shapes we read (defensive — every field optional) ──────────
interface TmdbMovieBase {
  id: number;
  title?: string;
  original_title?: string;
  original_language?: string;
  overview?: string;
  tagline?: string | null;
  status?: string;
  release_date?: string;
  runtime?: number | null;
  budget?: number;
  revenue?: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genres?: { id: number; name: string }[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  imdb_id?: string | null;
  homepage?: string | null;
  spoken_languages?: { iso_639_1: string; english_name?: string }[];
  production_companies?: { name: string }[];
  production_countries?: { name: string }[];
}
interface TmdbCastEntry { id: number; name: string; character?: string; order: number; profile_path?: string | null; }
interface TmdbCrewEntry { id: number; name: string; job: string; department?: string; profile_path?: string | null; }
interface TmdbCredits { id: number; cast?: TmdbCastEntry[]; crew?: TmdbCrewEntry[]; }

interface TmdbPerson {
  id: number;
  name: string;
  known_for_department?: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  gender?: number;
  also_known_as?: string[];
  imdb_id?: string | null;
  homepage?: string | null;
  popularity?: number;
  profile_path?: string | null;
  combined_credits?: {
    cast?: { id: number; title?: string; name?: string; character?: string; release_date?: string; first_air_date?: string; media_type?: string; popularity?: number }[];
  };
}

// ── Public shapes returned to the UI ─────────────────────────────────────────
// (Search now lives in search.ts — Google-style tokenized/ranked, uncached.)
export interface CastMember { id: number; name: string; character?: string; order: number; profileUrl?: string; }
export interface CrewMember { id: number; name: string; job: string; department?: string; profileUrl?: string; }

export interface MovieDetail {
  id: number;
  imdbId?: string;
  title: string;
  originalTitle?: string;
  tagline?: string;
  year?: number;
  status?: string;
  language?: string;
  audioLanguages?: { original: string; dubbed?: string[] };
  spokenLanguages?: string[];
  runtime?: number;
  genre: string[];
  synopsis?: string;
  director?: string;
  musicDirector?: string;
  leadCast?: string[];
  cast: CastMember[];
  crew: CrewMember[];
  releaseDate?: string;
  releaseDates?: { theatrical?: string; ott?: string };
  platforms: string[];
  ratings: {
    tmdbScore?: number;
    tmdbVotes?: number;
    tmdbPopularity?: number;
    imdbRating?: number;
    rottenTomatoes?: number;
    metacritic?: number;
  };
  posterUrl?: string;
  backdropUrl?: string;
  homepage?: string;
  budget?: number;
  revenue?: number;
  productionCompanies?: string[];
  productionCountries?: string[];
  notes: string[];
  /** Complete unmodified source payloads for the raw-JSON view. */
  rawData: Record<string, unknown>;
}

export interface PersonKnownFor { id: number; title: string; year?: number; character?: string; mediaType?: string; }
export interface PersonDetail {
  id: number;
  name: string;
  knownForDepartment?: string;
  biography?: string;
  birthday?: string;
  deathday?: string;
  placeOfBirth?: string;
  gender?: string;
  alsoKnownAs?: string[];
  imdbId?: string;
  homepage?: string;
  popularity?: number;
  profileUrl?: string;
  knownFor: PersonKnownFor[];
  images: ImageItem[];
  imageSources: string[];
  rawData: Record<string, unknown>;
}

export interface MovieImages { id: number; posters: ImageItem[]; backdrops: ImageItem[]; sources: string[]; rawData: Record<string, unknown>; }
export interface MovieCredits { id: number; cast: CastMember[]; crew: CrewMember[]; rawData: Record<string, unknown>; }
export interface MovieVideos { id: number; videos: VideoItem[]; sources: string[]; rawData: Record<string, unknown>; }
export interface MovieBackground { id: number; results: BackgroundResult[]; }

function genderName(g: number | undefined): string | undefined {
  return g === 1 ? "Female" : g === 2 ? "Male" : g === 3 ? "Non-binary" : undefined;
}
function yearOf(d: string | null | undefined): number | undefined {
  if (!d) return undefined;
  const y = Number.parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
}
function omdbRatingsFrom(raw: Record<string, unknown> | null): { imdbRating?: number; rottenTomatoes?: number; metacritic?: number } {
  if (!raw) return {};
  const out: { imdbRating?: number; rottenTomatoes?: number; metacritic?: number } = {};
  const imdb = raw["imdbRating"];
  if (typeof imdb === "string" && imdb !== "N/A") { const n = parseFloat(imdb); if (Number.isFinite(n)) out.imdbRating = n; }
  const ratings = raw["Ratings"];
  if (Array.isArray(ratings)) {
    for (const r of ratings as { Source?: string; Value?: string }[]) {
      if (r.Source === "Rotten Tomatoes" && r.Value) { const m = r.Value.match(/(\d+)/); if (m) out.rottenTomatoes = parseInt(m[1]!, 10); }
      if (r.Source === "Metacritic" && r.Value) { const m = r.Value.match(/(\d+)/); if (m) out.metacritic = parseInt(m[1]!, 10); }
    }
  }
  return out;
}

function mapCast(cast: TmdbCastEntry[]): CastMember[] {
  return cast.slice().sort((a, b) => a.order - b.order).map((c) => ({
    id: c.id, name: c.name, order: c.order,
    ...(c.character ? { character: c.character } : {}),
    ...(c.profile_path ? { profileUrl: img(c.profile_path, "w185") } : {}),
  }));
}
function mapCrew(crew: TmdbCrewEntry[]): CrewMember[] {
  return crew.slice().map((c) => ({
    id: c.id, name: c.name, job: c.job,
    ...(c.department ? { department: c.department } : {}),
    ...(c.profile_path ? { profileUrl: img(c.profile_path, "w185") } : {}),
  }));
}

// ── 2. Full detail for one movie id ──────────────────────────────────────────
export async function movieDetail(id: number): Promise<MovieDetail> {
  const notes: string[] = [];

  // Uncached base + credits (no cache.sqlite writes) + reused (cached) helpers.
  const [base, credits, cnl, platforms] = await Promise.all([
    tmdbGet<TmdbMovieBase>(`/movie/${id}`),
    tmdbGet<TmdbCredits>(`/movie/${id}/credits`),
    getCreditsAndLanguages(id),   // reuse
    getStreamingPlatforms(id),    // reuse
  ]);

  const imdbId = base.imdb_id ?? undefined;
  // OMDb raw (uncached, optional) — feeds ratings + the raw-JSON view.
  const omdbRaw = imdbId ? await omdbGet({ i: imdbId, plot: "full" }) : null;
  const omdbRatings = omdbRatingsFrom(omdbRaw);

  const cast = mapCast(credits.cast ?? []);
  const crew = mapCrew(credits.crew ?? []);
  const director = crew.find((c) => c.job === "Director")?.name;

  if (!omdbRaw) {
    notes.push("OMDb not consulted (no IMDb id or OMDB_API_KEY unset) — IMDb/RT/Metacritic omitted.");
  }

  const detail: MovieDetail = {
    id: base.id ?? id,
    imdbId,
    title: base.title ?? base.original_title ?? "(untitled)",
    originalTitle: base.original_title && base.original_title !== base.title ? base.original_title : undefined,
    tagline: base.tagline ?? undefined,
    year: yearOf(base.release_date),
    status: base.status,
    language: langName(base.original_language),
    audioLanguages: cnl.audioLanguages,
    spokenLanguages: (base.spoken_languages ?? []).map((l) => langName(l.iso_639_1) ?? l.english_name ?? l.iso_639_1).filter(Boolean),
    runtime: base.runtime ?? undefined,
    genre: cnl.genre && cnl.genre.length > 0 ? cnl.genre : (base.genres ?? []).map((g) => g.name),
    synopsis: cnl.synopsis ?? base.overview ?? undefined,
    director,
    musicDirector: cnl.musicDirector,
    leadCast: cnl.leadCast && cnl.leadCast.length > 0 ? cnl.leadCast : undefined,
    cast,
    crew,
    releaseDate: base.release_date || undefined,
    releaseDates: cnl.releaseDates,
    platforms,
    ratings: {
      tmdbScore: typeof base.vote_average === "number" ? base.vote_average : undefined,
      tmdbVotes: typeof base.vote_count === "number" ? base.vote_count : undefined,
      tmdbPopularity: typeof base.popularity === "number" ? base.popularity : undefined,
      ...omdbRatings,
    },
    posterUrl: img(base.poster_path, "w500"),
    backdropUrl: img(base.backdrop_path, "w1280"),
    homepage: base.homepage ?? undefined,
    budget: base.budget || undefined,
    revenue: base.revenue || undefined,
    productionCompanies: (base.production_companies ?? []).map((c) => c.name),
    productionCountries: (base.production_countries ?? []).map((c) => c.name),
    notes,
    rawData: {
      tmdb: { movie: base, credits, creditsAndLanguages: cnl, streamingPlatforms: platforms },
      omdb: omdbRaw,
    },
  };
  return detail;
}

// ── 3. Full image gallery (aggregated across sources) ────────────────────────
export async function allMovieImages(tmdbId: number, imdbId?: string): Promise<MovieImages> {
  const agg = await aggregateMovieImages({ tmdbId, ...(imdbId ? { imdbId } : {}) });
  return {
    id: tmdbId,
    posters: agg.items.filter((i) => i.kind === "poster"),
    backdrops: agg.items.filter((i) => i.kind === "backdrop"),
    sources: agg.sources,
    rawData: agg.raw,
  };
}

// ── 3b. Videos / trailers (aggregated across sources) ────────────────────────
export async function movieVideos(tmdbId: number): Promise<MovieVideos> {
  const agg = await aggregateMovieVideos({ tmdbId });
  return { id: tmdbId, videos: agg.items, sources: agg.sources, rawData: agg.raw };
}

// ── 3c. Wikipedia (or future) background ─────────────────────────────────────
export async function movieBackground(tmdbId: number, title: string, year?: number): Promise<MovieBackground> {
  const results = await aggregateBackground(title, year);
  return { id: tmdbId, results };
}

// ── 4. Full cast + crew ──────────────────────────────────────────────────────
export async function fullCredits(id: number): Promise<MovieCredits> {
  const credits = await tmdbGet<TmdbCredits>(`/movie/${id}/credits`);
  return {
    id,
    cast: mapCast(credits.cast ?? []),
    crew: mapCrew(credits.crew ?? []),
    rawData: { tmdb: { credits } },
  };
}

// ── 5. Person detail + full image gallery ────────────────────────────────────
export async function personDetail(id: number): Promise<PersonDetail> {
  const [person, imagesAgg] = await Promise.all([
    tmdbGet<TmdbPerson>(`/person/${id}`, { append_to_response: "combined_credits" }),
    aggregatePersonImages({ tmdbId: id }),
  ]);

  const knownFor: PersonKnownFor[] = (person.combined_credits?.cast ?? [])
    .slice()
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      title: c.title ?? c.name ?? "(untitled)",
      year: yearOf(c.release_date ?? c.first_air_date),
      ...(c.character ? { character: c.character } : {}),
      ...(c.media_type ? { mediaType: c.media_type } : {}),
    }));

  return {
    id: person.id,
    name: person.name,
    knownForDepartment: person.known_for_department,
    biography: person.biography || undefined,
    birthday: person.birthday ?? undefined,
    deathday: person.deathday ?? undefined,
    placeOfBirth: person.place_of_birth ?? undefined,
    gender: genderName(person.gender),
    alsoKnownAs: person.also_known_as && person.also_known_as.length > 0 ? person.also_known_as : undefined,
    imdbId: person.imdb_id ?? undefined,
    homepage: person.homepage ?? undefined,
    popularity: person.popularity,
    profileUrl: img(person.profile_path, "w300"),
    knownFor,
    images: imagesAgg.items,
    imageSources: imagesAgg.sources,
    rawData: { tmdb: { person, images: imagesAgg.raw["tmdb"] } },
  };
}

// ── Download-proxy host whitelist (SSRF guard) ───────────────────────────────
const ALLOWED_IMAGE_HOSTS = new Set([
  "image.tmdb.org",
  "m.media-amazon.com",
  "images-na.ssl-images-amazon.com",
  "ia.media-imdb.com",
]);
export function isAllowedImageUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && ALLOWED_IMAGE_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
