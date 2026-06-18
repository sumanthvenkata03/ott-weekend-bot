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
import { getMdblistRatings, mergeRatings, computeTbsiScore } from "../ratings/mdblist.js";
import { discoverIndianOTTArrivals } from "./tmdb.js";

/**
 * Phase 5.7 — merge OMDb Language (comma-separated dub list) into the
 * existing TMDb-derived audioLanguages. Excludes the original language and
 * filters "English" from the dub list (almost always subtitle-only on
 * Indian films, treat as noise unless it's the original).
 *
 * Logs a one-liner when the two sources disagree, so dry-run monitoring
 * can spot films where one source is missing dubs the other found.
 */
function mergeAudioLanguages(
  current: { original: string; dubbed?: string[] } | undefined,
  omdbLanguages: string[],
  filmTitle: string
): { original: string; dubbed?: string[] } | undefined {
  if (!current) return undefined;
  const tmdbDubs = current.dubbed ?? [];

  const allDubs = new Set<string>([...tmdbDubs, ...omdbLanguages]);
  allDubs.delete(current.original);
  if (current.original !== "English") allDubs.delete("English");

  // Disagreement detection: did OMDb know a dub TMDb didn't, or vice versa?
  const tmdbSet = new Set(tmdbDubs);
  const omdbDubsForCompare = new Set(omdbLanguages);
  omdbDubsForCompare.delete(current.original);
  if (current.original !== "English") omdbDubsForCompare.delete("English");
  const onlyInTmdb = tmdbDubs.filter(x => !omdbDubsForCompare.has(x));
  const onlyInOmdb = Array.from(omdbDubsForCompare).filter(x => !tmdbSet.has(x));
  if (onlyInTmdb.length > 0 || onlyInOmdb.length > 0) {
    const merged = Array.from(allDubs).sort();
    log.info(
      `  [lang-merge] ${filmTitle}: ` +
      `TMDb=[${tmdbDubs.join(",") || "—"}] ` +
      `OMDb=[${omdbLanguages.join(",") || "—"}] ` +
      `→ merged=[${merged.join(",") || "—"}]`
    );
  }

  const merged = Array.from(allDubs).sort();
  return {
    original: current.original,
    ...(merged.length > 0 ? { dubbed: merged } : {}),
  };
}

/**
 * Enrich ratings: MDBList PRIMARY (richer, multi-source), OMDb fills the gaps,
 * plus a coverage-aware TBSI Score. Both sources are fetched in parallel and
 * keyed off the IMDb ID; either being absent (no key / miss / no IMDb ID)
 * degrades gracefully. OMDb's language/cast/runtime enrichment role is UNCHANGED
 * (applied exactly as before, only when OMDb responds).
 *
 * Merge precedence per field:
 *   imdbRating     = mdblist.imdb      ?? omdb.imdbRating     ?? existing
 *   rottenTomatoes = mdblist.rtCritic  ?? omdb.rottenTomatoes ?? existing
 *   rtAudience     = mdblist.rtAudience ?? existing            (OMDb has none)
 *   metacritic     = mdblist.metacritic ?? omdb.metacritic    ?? existing
 *   letterboxd     = mdblist.letterboxd ?? existing            (OMDb has none)
 */
async function enrichWithRatings(releases: Release[]): Promise<Release[]> {
  return Promise.all(
    releases.map(async r => {
      if (!r.imdbId) return r;
      const [omdb, mdblist] = await Promise.all([
        fetchOmdbByImdbId(r.imdbId),
        getMdblistRatings(r.imdbId),
      ]);
      if (!omdb && !mdblist) return r;

      const m = mergeRatings(r, omdb, mdblist);
      const { tbsiScore, tbsiSourceCount } = computeTbsiScore(m);

      // OMDb language/cast/runtime role — UNCHANGED, applied only when OMDb responded.
      const mergedAudio = omdb ? mergeAudioLanguages(r.audioLanguages, omdb.languages, r.title) : undefined;

      return {
        ...r,
        ...(omdb ? {
          imdbVotes: omdb.imdbVotes,
          director: omdb.director ?? r.director,
          cast: omdb.cast.length > 0 ? omdb.cast : r.cast,
          runtime: omdb.runtime ?? r.runtime,
        } : {}),
        ...(mergedAudio ? { audioLanguages: mergedAudio } : {}),
        // Ratings — conditional spreads so we never write an explicit undefined.
        ...(m.imdbRating !== undefined ? { imdbRating: m.imdbRating } : {}),
        ...(m.rottenTomatoes !== undefined ? { rottenTomatoes: m.rottenTomatoes } : {}),
        ...(m.rtAudience !== undefined ? { rtAudience: m.rtAudience } : {}),
        ...(m.metacritic !== undefined ? { metacritic: m.metacritic } : {}),
        ...(m.letterboxd !== undefined ? { letterboxd: m.letterboxd } : {}),
        ...(tbsiScore !== undefined ? { tbsiScore } : {}),
        ...(tbsiSourceCount !== undefined ? { tbsiSourceCount } : {}),
        sources: Array.from(new Set([
          ...r.sources,
          ...(omdb ? ["omdb"] : []),
          ...(mdblist ? ["mdblist"] : []),
        ])),
      };
    })
  );
}

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
        ...(data.releaseDates ? { releaseDates: data.releaseDates } : {}),
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

  // 4. Enrich ratings — MDBList primary + OMDb gap-fill (+ Phase 5.7 audio merge)
  log.info(`Enriching ratings with MDBList + OMDb...`);
  const enriched = await enrichWithRatings(withCredits);

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

  log.info(`Enriching ratings with MDBList + OMDb...`);
  const enriched = await enrichWithRatings(withCredits);

  return enriched;
}