// src/ingestion/releases/index.ts
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import { discoverIndianReleases, getImdbId, getStreamingPlatforms } from "./tmdb.js";
import { fetchOmdbByImdbId } from "./omdb.js";

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
  
  // 4. Enrich with OMDb
  log.info(`Enriching with OMDb (IMDb ratings + RT)...`);
  const enriched = await Promise.all(
    withPlatforms.map(async r => {
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