// src/ingestion/releases/index.ts
import { log } from "../../shared/logger.js";
import type { Release, Language } from "../../shared/types.js";
import { isIndianFilm, countryGateLine, type CountryFields } from "../../shared/country-gate.js";
import {
  discoverIndianReleases,
  getImdbId,
  getStreamingPlatforms,
  getCreditsAndLanguages,
} from "./tmdb.js";
import { fetchOmdbByImdbId } from "./omdb.js";
import { getMdblistRatings, mergeRatings, computeTbsiScore } from "../ratings/mdblist.js";
import { discoverIndianOTTArrivals } from "./tmdb.js";

// OMDb cross-source sanity set. This is a WRONG-FILM detector, NOT audience
// curation: OMDb keys off the IMDb id, and a mis-resolved id returns another
// film's languages entirely (the Lenin case — a Tamil film tagged "Russian").
// An OMDb-contributed language is trusted only if it is a plausible Indian-release
// language OR TMDb already vouches for it. Bengali stays PLAUSIBLE — big pan-India
// films genuinely ship Bengali dubs, so a real "Bengali" chip is honest data —
// even though we no longer COVER Bengali cinema (a separate discovery decision).
const PLAUSIBLE_RELEASE_LANGS = new Set<string>([
  "Telugu", "Tamil", "Hindi", "Malayalam", "Kannada", "Marathi", "Punjabi", "Bengali", "English",
]);

/**
 * Phase 5.7 — merge OMDb Language (comma-separated dub list) into the
 * existing TMDb-derived audioLanguages. Excludes the original language and
 * filters "English" from the dub list (almost always subtitle-only on
 * Indian films, treat as noise unless it's the original).
 *
 * Cross-source sanity: an OMDb-only language that is implausible for an Indian
 * release (and not already in TMDb's data) is DROPPED as a probable wrong-film-id
 * artifact, with a loud log line — the "Russian on a Tamil film" class of bug
 * never reaches a card. Logs a one-liner when the two sources disagree, so dry-run
 * monitoring can spot films where one source is missing dubs the other found.
 *
 * Exported for direct unit testing of the sanity filter.
 */
export function mergeAudioLanguages(
  current: { original: string; dubbed?: string[] } | undefined,
  omdbLanguages: string[],
  filmTitle: string
): { original: string; dubbed?: string[] } | undefined {
  if (!current) return undefined;
  const tmdbDubs = current.dubbed ?? [];

  // TMDb data is trusted; screen each OMDb language before it can merge in.
  const tmdbTrusted = new Set<string>([current.original, ...tmdbDubs]);
  const omdbAccepted: string[] = [];
  for (const lang of omdbLanguages) {
    if (PLAUSIBLE_RELEASE_LANGS.has(lang) || tmdbTrusted.has(lang)) {
      omdbAccepted.push(lang);
    } else {
      log.info(
        `  [lang-merge] dropped OMDb-only '${lang}' (implausible for Indian release — possible wrong-film id) [${filmTitle}]`
      );
    }
  }

  const allDubs = new Set<string>([...tmdbDubs, ...omdbAccepted]);
  allDubs.delete(current.original);
  if (current.original !== "English") allDubs.delete("English");

  // Disagreement detection: did OMDb know a dub TMDb didn't, or vice versa?
  // Compared over the ACCEPTED OMDb set, so a dropped wrong-film value never
  // masquerades as a real cross-source disagreement.
  const tmdbSet = new Set(tmdbDubs);
  const omdbDubsForCompare = new Set(omdbAccepted);
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
 * Reconcile the audio "original" track with the discover-derived language.
 *
 * `audio.original` is built upstream from TMDb's /movie/{id} original_language,
 * which can disagree with the discover index that set `r.language` — e.g. Thank
 * You Subbarao, a Telugu film whose detail record wrongly reports "en" (class-(a)
 * source-data bug). `r.language` is the value the rest of the card already trusts
 * (poster, title, fallback color), so prefer it for the original track. This
 * self-corrects ANY future detail/discover disagreement, not just this one film.
 *
 * `dubbed` stays TMDb-sourced — original and dubbed are different facts (what the
 * film IS vs which other tracks exist) and must keep separate sources. Any dub
 * equal to the reconciled original is dropped (normalized compare) so the card
 * never shows "Telugu · also Telugu". Falls back to the detail-derived original
 * when `r.language` is absent or unclassified ("Other"), so films that already
 * render correctly never regress.
 */
function reconcileAudioOriginal(
  audio: { original: string; dubbed?: string[] } | undefined,
  releaseLanguage: Language
): { original: string; dubbed?: string[] } | undefined {
  if (!audio) return undefined;
  const original =
    releaseLanguage && releaseLanguage !== "Other" ? releaseLanguage : audio.original;
  const norm = (s: string) => s.trim().toLowerCase();
  const dubbed = (audio.dubbed ?? []).filter(d => norm(d) !== norm(original));
  return {
    original,
    ...(dubbed.length > 0 ? { dubbed } : {}),
  };
}

/**
 * Merge TMDb-derived release dates over a stub's existing ones WITHOUT clobbering
 * a press-sourced ott date. TMDb wins per-field when present; a blank TMDb ott
 * falls back to the stub's press ott — the Blast rescue (mirrors the reconcile
 * layer's assessDates precedence). For the OLD ingest path the stub has no
 * releaseDates, so this returns exactly TMDb's — output stays identical.
 */
function mergeReleaseDates(
  existing: { theatrical?: string; ott?: string } | undefined,
  incoming: { theatrical?: string; ott?: string } | undefined
): { theatrical?: string; ott?: string } | undefined {
  const theatrical = incoming?.theatrical ?? existing?.theatrical;
  const ott = incoming?.ott ?? existing?.ott;
  if (!theatrical && !ott) return undefined;
  return {
    ...(theatrical ? { theatrical } : {}),
    ...(ott ? { ott } : {}),
  };
}

/**
 * Phase 5.5 — apply credits + audio-language enrichment to a release list.
 * Pulls top-2 billed cast, music composer, and { original, dubbed } language
 * structure from TMDb in one helper call per film. Returns release records
 * with leadCast/musicDirector/audioLanguages spread in when available.
 *
 * Step 2 — also BACKFILLS poster/synopsis/genre/popularity from the same
 * /movie/{id} response, but ONLY for lean discovery stubs. The discriminator is
 * a missing `tmdbPopularity`: the old ingest path ALWAYS sets it from the
 * discover row, so `needsBackfill` is false there and that path's output is
 * byte-identical; a discovery stub carries no tmdbPopularity, so it gets filled.
 */
/**
 * A release paired with the raw country fields from its /movie/{id} response.
 * The pairing is transient — it exists only between the credits step and the
 * country gate, so no country data leaks into the Release type or onto a card.
 */
export interface ReleaseWithCountry {
  release: Release;
  /** undefined ⇒ no detail fetch happened (no tmdbId). The gate fails open. */
  countries?: CountryFields;
}

/**
 * COUNTRY GATE · seam (a). Drops films TMDb states are NOT from India.
 *
 * PURE — the country data was already fetched upstream, so this makes no calls
 * and is directly unit-testable. Every outcome is logged (pass, ⚠ pass and
 * reject alike): a silent reject would look identical to a film TMDb never had.
 *
 * Placement is load-bearing, not incidental: this runs AFTER the /movie/{id}
 * credits step (which is where country data first exists) and BEFORE the ratings
 * step, so a rejected film never costs an OMDb or an MDBList call.
 */
export function applyCountryGate(items: ReleaseWithCountry[]): Release[] {
  const kept: Release[] = [];
  let rejected = 0;
  let warned = 0;
  for (const { release, countries } of items) {
    const verdict = isIndianFilm(countries ?? {});
    log.info(countryGateLine("ingest", release.title, release.tmdbId, verdict));
    if (!verdict.ok) { rejected++; continue; }
    if (!verdict.present) warned++;
    kept.push(release);
  }
  if (rejected > 0 || warned > 0) {
    log.info(
      `  [country-gate/ingest] ${kept.length}/${items.length} kept — ` +
      `${rejected} rejected as non-Indian, ${warned} passed with ⚠ (no TMDb country data)`
    );
  }
  return kept;
}

async function enrichWithCreditsAndLanguages(releases: Release[]): Promise<ReleaseWithCountry[]> {
  return Promise.all(
    releases.map(async r => {
      if (!r.tmdbId) return { release: r };
      const data = await getCreditsAndLanguages(r.tmdbId);
      // Trust the discover-derived language for the original track; keep TMDb's
      // spoken_languages for dubbed. See reconcileAudioOriginal for the why.
      const audioLanguages = reconcileAudioOriginal(data.audioLanguages, r.language);

      // Only lean discovery stubs lack tmdbPopularity; the old discover row
      // always sets it. Gate ALL backfill on this so the old path is untouched.
      const needsBackfill = r.tmdbPopularity === undefined;

      // Merge (not overwrite) release dates so a press-sourced ott date on an
      // AI-OTT discovery stub survives a TMDb response that only has theatrical.
      const merged = mergeReleaseDates(r.releaseDates, data.releaseDates);

      // R2 — DISCOVER FALLBACK. TMDb's /movie/{id}/release_dates is queried for
      // the IN row only, and plenty of Indian films carry no IN row at all
      // (Chennai Love Story had AU/GB/IE/NZ/US and nothing for India). The film
      // still HAS a real date — the discover row's primary release_date, already
      // on this record — so use it rather than render a card with no ★ RELEASED
      // band. Flagged so the manifest can warn on the weaker provenance.
      const needsFallback = !merged?.theatrical && !merged?.ott && Boolean(r.releaseDate);
      const mergedReleaseDates = needsFallback
        ? { theatrical: r.releaseDate }
        : merged;

      const release: Release = {
        ...r,
        ...(data.leadCast.length > 0 ? { leadCast: data.leadCast } : {}),
        ...(data.musicDirector ? { musicDirector: data.musicDirector } : {}),
        ...(audioLanguages ? { audioLanguages } : {}),
        ...(mergedReleaseDates ? { releaseDates: mergedReleaseDates } : {}),
        ...(needsFallback ? { releaseDatesFallback: "discover" as const } : {}),
        // Backfill — discovery stubs only; never overwrites an existing value.
        ...(needsBackfill && data.posterUrl && !r.posterUrl ? { posterUrl: data.posterUrl } : {}),
        ...(needsBackfill && data.synopsis && !r.synopsis ? { synopsis: data.synopsis } : {}),
        ...(needsBackfill && data.genre && data.genre.length > 0 && r.genre.length === 0 ? { genre: data.genre } : {}),
        ...(needsBackfill && data.tmdbPopularity !== undefined ? { tmdbPopularity: data.tmdbPopularity } : {}),
        ...(needsBackfill && data.tmdbVoteAverage !== undefined && r.tmdbVoteAverage === undefined ? { tmdbVoteAverage: data.tmdbVoteAverage } : {}),
        ...(needsBackfill && data.tmdbVoteCount !== undefined && r.tmdbVoteCount === undefined ? { tmdbVoteCount: data.tmdbVoteCount } : {}),
      };
      // Countries travel BESIDE the release, never on it — see ReleaseWithCountry.
      return { release, ...(data.countries ? { countries: data.countries } : {}) };
    })
  );
}

/**
 * Step 2 — the SHARED enrichment seam. Takes a list of Release "stubs" (at least
 * { tmdbId, title, language, releaseDate }) and runs the full enrichment chain:
 *   1. resolve IMDb IDs        (getImdbId)
 *   2. streaming platforms     (getStreamingPlatforms — JustWatch via TMDb)
 *   3. credits + audio + /movie/{id} backfill (getCreditsAndLanguages)
 *   4. ratings                 (MDBList primary + OMDb gap-fill + TBSI score)
 *
 * This is the ONE enrichment path: ingestReleases, ingestOTTArrivals AND the new
 * discovery-backed getCandidates() all call it, so enrichment is never
 * duplicated. The stages are lifted verbatim from the previous in-function code.
 */
export interface EnrichOptions {
  /**
   * R3 — skip seam (a) of the country gate for films that ALREADY passed it at
   * another seam. AI-net finds are gated at seam (b) (reconcile's new-movie
   * guard) before they reach here; re-running the gate would re-log every
   * verdict and print a SECOND ⚠ for the same film, making the audit read as
   * though it were checked twice. The gate itself is not weakened — the film
   * was already rejected-or-passed upstream, by the same pure predicate.
   */
  skipCountryGate?: boolean;
}

export async function enrichReleases(stubs: Release[], opts: EnrichOptions = {}): Promise<Release[]> {
  if (stubs.length === 0) return stubs;

  // 1. Resolve IMDb IDs
  log.info(`Resolving IMDb IDs for ${stubs.length} releases...`);
  const withImdb = await Promise.all(
    stubs.map(async r => {
      if (!r.tmdbId) return r;
      const imdbId = await getImdbId(r.tmdbId);
      return { ...r, imdbId: imdbId ?? undefined };
    })
  );
  log.info(`  IMDb IDs found: ${withImdb.filter(r => r.imdbId).length}/${stubs.length}`);

  // 2. Fetch streaming platforms (JustWatch via TMDb)
  log.info(`Fetching streaming platforms (JustWatch via TMDb)...`);
  const withPlatforms = await Promise.all(
    withImdb.map(async r => {
      if (!r.tmdbId) return r;
      const platforms = await getStreamingPlatforms(r.tmdbId);
      // Additive-only: a JustWatch miss returns [] — do NOT let that wipe a
      // platform the discovery/press net already resolved into the stub
      // (candidates.ts, enum-normalized). Only overwrite when JustWatch actually
      // found something. Never invents a platform.
      return { ...r, platform: platforms.length > 0 ? platforms : r.platform };
    })
  );
  log.info(`  Streaming on at least 1 platform: ${withPlatforms.filter(r => r.platform.length > 0).length}/${stubs.length}`);

  // 3. Credits + audio language structure (+ Step 2 poster/synopsis/genre/popularity backfill)
  log.info(`Fetching credits + audio languages...`);
  const withCredits = await enrichWithCreditsAndLanguages(withPlatforms);
  const enrichedCount = withCredits.filter(
    ({ release: r }) => r.leadCast || r.musicDirector || r.audioLanguages
  ).length;
  log.info(`  Credits/audio enrichment: ${enrichedCount}/${stubs.length}`);

  // 3.5 COUNTRY GATE (seam a). Deliberately BETWEEN steps 3 and 4: step 3 is the
  // first point country data exists, and rejecting here means a non-Indian film
  // never costs the OMDb + MDBList calls step 4 would spend on it.
  let indian: Release[];
  if (opts.skipCountryGate) {
    log.info(`Country gate skipped — already gated upstream (seam b).`);
    indian = withCredits.map((x) => x.release);
  } else {
    log.info(`Applying country gate (India-origin)...`);
    indian = applyCountryGate(withCredits);
  }

  // 4. Enrich ratings — MDBList primary + OMDb gap-fill (+ Phase 5.7 audio merge)
  log.info(`Enriching ratings with MDBList + OMDb...`);
  return enrichWithRatings(indian);
}

export async function ingestReleases(
  startDate: string,
  endDate: string
): Promise<Release[]> {
  // 1. Discover
  const releases = await discoverIndianReleases(startDate, endDate);
  if (releases.length === 0) return releases;

  // 2-4. Shared enrichment seam (IMDb → platforms → credits/audio → ratings).
  const enriched = await enrichReleases(releases);

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

  // Shared enrichment seam — identical chain as ingestReleases.
  return enrichReleases(releases);
}
