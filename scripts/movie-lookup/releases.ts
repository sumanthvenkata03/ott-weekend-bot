// scripts/movie-lookup/releases.ts
// "Now in cinemas" + "Upcoming" feeds for a region (default India / IN), wrapping
// TMDb /movie/now_playing and /movie/upcoming. Read-only reuse of the shared
// tmdbGet helper; the server caches responses via the existing TTL cache.

import { tmdbGet, img, langName } from "./sources.js";

export type ReleaseKind = "now_playing" | "upcoming";

export interface ReleaseItem {
  id: number;
  title: string;
  year?: number;
  releaseDate?: string;
  posterUrl?: string;
  language?: string;
  voteAverage?: number;
  popularity?: number;
}

export interface ReleasesResult {
  region: string;
  kind: ReleaseKind;
  results: ReleaseItem[];
}

interface TmdbListItem {
  id: number;
  title?: string;
  release_date?: string;
  poster_path?: string | null;
  vote_average?: number;
  popularity?: number;
  original_language?: string;
}
interface TmdbListResponse {
  results?: TmdbListItem[];
}

function yearOf(date?: string): number | undefined {
  if (!date) return undefined;
  const y = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
}

/** Pure mapper (network-free) so it can be unit-tested. */
export function mapReleases(raw: TmdbListResponse, kind: ReleaseKind, region: string): ReleasesResult {
  const items: ReleaseItem[] = (raw.results ?? []).map((r) => ({
    id: r.id,
    title: r.title ?? "(untitled)",
    ...(yearOf(r.release_date) !== undefined ? { year: yearOf(r.release_date) } : {}),
    ...(r.release_date ? { releaseDate: r.release_date } : {}),
    ...(r.poster_path ? { posterUrl: img(r.poster_path, "w342") } : {}),
    ...(r.original_language ? { language: langName(r.original_language) } : {}),
    ...(typeof r.vote_average === "number" ? { voteAverage: r.vote_average } : {}),
    ...(typeof r.popularity === "number" ? { popularity: r.popularity } : {}),
  }));
  // Upcoming: soonest first; Now playing: most popular first.
  items.sort((a, b) =>
    kind === "upcoming"
      ? (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999")
      : (b.popularity ?? 0) - (a.popularity ?? 0)
  );
  return { region, kind, results: items };
}

export async function movieReleases(kind: ReleaseKind, region = "IN"): Promise<ReleasesResult> {
  const path = kind === "upcoming" ? "/movie/upcoming" : "/movie/now_playing";
  const raw = await tmdbGet<TmdbListResponse>(path, { region, language: "en-US", page: "1" });
  return mapReleases(raw, kind, region);
}
