// src/ingestion/releases/index.ts
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import {
  discoverIndianReleases,
  getImdbId,
  getStreamingPlatforms,
  getCreditsAndLanguages,
} from "./tmdb.js";
import { fetchOmdbByImdbId } from "./omdb.js";
import { discoverIndianOTTArrivals } from "./tmdb.js";

/**
 * Phase 5.5 — apply credits + audio-language enrichment to a release list.
 * Pulls top-2 billed cast, music composer, and { original, dubbed } language
 * structure from TMDb in one helper call per film. Returns release records
 * with leadCast/musicDirector/audioLanguages spread in when available.
 */
async function enrichWithCreditsAndLanguages(releases: Release[]): Promise<Release[]> {
  return Promise.all(
    releases.map(async r => {
      if (!r.tmdbId) return r;
      const data = await getCreditsAndLanguages(r.tmdbId);
      return {
        ...r,
        ...(data.leadCast.length > 0 ? { leadCast: data.leadCast } : {}),
        ...(data.musicDirector ? { musicDirector: data.musicDirector } : {}),
        ...(data.audioLanguages ? { audioLanguages: data.audioLanguages } : {}),
      };
    })
  );
}

export async function ingestReleases(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  // 1. Discover
  const releases = await discoverIndianReleases(startDate, endDate);
  if (releases.length === 0) return releases;
  
  // 2. Resolve IMDb IDs
  log.info(`Resolving IMDb IDs for ${releases.length} releases...`);
  const withImdb = await Promise.all(
    releases.map(async r => {
      if (!r.tmdbId) return r;
      const imdbId = await getImdbId(r.tmdbId);
      return { ...r, imdbId: imdbId ?? undefined };
    })
  );
  log.info(`  IMDb IDs found: ${withImdb.filter(r => r.imdbId).length}/${releases.length}`);
  
  // 3. Fetch streaming platforms (JustWatch via TMDb)
  log.info(`Fetching streaming platforms (JustWatch via TMDb)...`);
  const withPlatforms = await Promise.all(
    withImdb.map(async r => {
      if (!r.tmdbId) return r;
      const platforms = await getStreamingPlatforms(r.tmdbId);
      return { ...r, platform: platforms };
    })
  );
  log.info(`  Streaming on at least 1 platform: ${withPlatforms.filter(r => r.platform.length > 0).length}/${releases.length}`);

  // 3.5. Phase 5.5 — enrich with TMDb credits + audio language structure
  log.info(`Fetching credits + audio languages...`);
  const withCredits = await enrichWithCreditsAndLanguages(withPlatforms);
  const enrichedCount = withCredits.filter(r => r.leadCast || r.musicDirector || r.audioLanguages).length;
  log.info(`  Credits/audio enrichment: ${enrichedCount}/${releases.length}`);

  // 4. Enrich with OMDb
  log.info(`Enriching with OMDb (IMDb ratings + RT)...`);
  const enriched = await Promise.all(
    withCredits.map(async r => {
      if (!r.imdbId) return r;
      const omdb = await fetchOmdbByImdbId(r.imdbId);
      if (!omdb) return r;
      return {
        ...r,
        imdbRating: omdb.imdbRating,
        imdbVotes: omdb.imdbVotes,
        rottenTomatoes: omdb.rottenTomatoes,
        director: omdb.director ?? r.director,
        cast: omdb.cast.length > 0 ? omdb.cast : r.cast,
        runtime: omdb.runtime ?? r.runtime,
        sources: Array.from(new Set([...r.sources, "omdb"])),
      };
    })
  );
  
  const ratedCount = enriched.filter(r => r.imdbRating !== undefined).length;
  log.success(
    `Pipeline complete — ${enriched.length} releases ` +
    `(${ratedCount} rated, ${enriched.filter(r => r.platform.length > 0).length} on a platform)`
  );
  
  return enriched;
}


/**
 * Ingest just-arrived OTT films in the date range, fully enriched.
 * Mirrors ingestReleases() but uses release_type=4 filter for OTT-first films.
 */
export async function ingestOTTArrivals(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  const releases = await discoverIndianOTTArrivals(startDate, endDate);
  if (releases.length === 0) return releases;
  
  log.info(`Resolving IMDb IDs for ${releases.length} arrivals...`);
  const withImdb = await Promise.all(
    releases.map(async r => {
      if (!r.tmdbId) return r;
      const imdbId = await getImdbId(r.tmdbId);
      return { ...r, imdbId: imdbId ?? undefined };
    })
  );
  
  log.info(`Fetching streaming platforms...`);
  const withPlatforms = await Promise.all(
    withImdb.map(async r => {
      if (!r.tmdbId) return r;
      const platforms = await getStreamingPlatforms(r.tmdbId);
      return { ...r, platform: platforms };
    })
  );

  // Phase 5.5 — credits + audio languages
  log.info(`Fetching credits + audio languages...`);
  const withCredits = await enrichWithCreditsAndLanguages(withPlatforms);

  log.info(`Enriching with OMDb...`);
  const enriched = await Promise.all(
    withCredits.map(async r => {
      if (!r.imdbId) return r;
      const omdb = await fetchOmdbByImdbId(r.imdbId);
      if (!omdb) return r;
      return {
        ...r,
        imdbRating: omdb.imdbRating,
        imdbVotes: omdb.imdbVotes,
        rottenTomatoes: omdb.rottenTomatoes,
        director: omdb.director ?? r.director,
        cast: omdb.cast.length > 0 ? omdb.cast : r.cast,
        runtime: omdb.runtime ?? r.runtime,
        sources: Array.from(new Set([...r.sources, "omdb"])),
      };
    })
  );
  
  return enriched;
}