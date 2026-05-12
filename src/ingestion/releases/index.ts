// src/ingestion/releases/index.ts
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import { discoverIndianReleases, getImdbId } from "./tmdb.js";
import { fetchOmdbByImdbId } from "./omdb.js";

/**
 * Full ingestion pipeline for OTT releases:
 *  1. Discover from TMDb (multi-language sweep)
 *  2. Resolve IMDb IDs
 *  3. Enrich with OMDb (ratings, RT, director, cast, runtime)
 */
export async function ingestReleases(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  // Step 1
  const releases = await discoverIndianReleases(startDate, endDate);
  
  if (releases.length === 0) return releases;
  
  // Step 2: resolve IMDb IDs (parallel, throttled by tmdbFetch internally)
  log.info(`Resolving IMDb IDs for ${releases.length} releases...`);
  const withImdb = await Promise.all(
    releases.map(async r => {
      if (!r.tmdbId) return r;
      const imdbId = await getImdbId(r.tmdbId);
      return { ...r, imdbId: imdbId ?? undefined };
    })
  );
  
  const resolvedCount = withImdb.filter(r => r.imdbId).length;
  log.info(`  IMDb IDs found: ${resolvedCount}/${releases.length}`);
  
  // Step 3: enrich with OMDb where we have an IMDb ID
  log.info(`Enriching with OMDb (IMDb ratings + RT)...`);
  const enriched = await Promise.all(
    withImdb.map(async r => {
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
  log.success(`OMDb: enriched ${ratedCount}/${releases.length} with IMDb ratings`);
  
  return enriched;
}