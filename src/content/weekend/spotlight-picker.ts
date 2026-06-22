// src/content/weekend/spotlight-picker.ts
import { log } from "../../shared/logger.js";
import type { Release, Language } from "../../shared/types.js";

const UNDERSERVED: Language[] = ["Malayalam", "Kannada", "Marathi", "Bengali", "Punjabi"];
const MAINSTREAM: Language[] = ["Hindi", "Telugu", "Tamil"];

/**
 * Score a release for spotlight worthiness.
 * Higher = more spotlight-worthy.
 *
 * Composite of:
 *  - Language priority (underserved gets big boost)
 *  - IMDb rating weighted by log(votes) — penalizes low-vote outliers
 *  - Has a real director attribution
 *  - Has cast attribution
 *  - Has a streaming platform (vs TBA)
 *  - Has a real synopsis (not just one sentence)
 */
function spotlightScore(r: Release): number {
  let score = 0;

  // Language priority
  if (UNDERSERVED.includes(r.language)) score += 50;
  else if (MAINSTREAM.includes(r.language)) score += 20;

  // IMDb signal — heavily weighted by vote count
  if (r.imdbRating !== undefined && r.imdbVotes !== undefined && r.imdbVotes > 0) {
    const voteWeight = Math.log10(r.imdbVotes + 1) / 5;
    score += r.imdbRating * voteWeight * 5;
  }

  // Production signals
  if (r.director) score += 10;
  if (r.cast.length >= 2) score += 8;
  if (r.runtime && r.runtime >= 80) score += 5;

  // Synopsis depth — granular, breaks ties
  if (r.synopsis.length > 100) score += 2;
  if (r.synopsis.length > 200) score += 3;
  if (r.synopsis.length > 400) score += 3;

  // Has a poster — TMDb often lacks this for stub entries
  if (r.posterUrl) score += 3;

  // Streaming confirmed
  if (r.platform.length > 0) score += 8;

  // Genre signal — thrillers/dramas/mysteries get a small bump for spotlight
  // (these are the genres regional cinema typically wins on)
  const STRONG_GENRES = ["Thriller", "Drama", "Mystery", "Crime"];
  if (r.genre.some(g => STRONG_GENRES.includes(g))) score += 4;

  // Tiny random tiebreaker so consecutive ties don't always pick the same film
  // Deterministic-per-film via hash of ID, so re-runs of same data give same answer
  const seed = r.id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  score += (seed % 100) / 100;   // 0.00 to 0.99

  return score;
}

/**
 * Pick the single best release for Sunday Spotlight.
 * Returns null only if releases is empty.
 */
export function pickSpotlight(releases: Release[]): Release | null {
  if (releases.length === 0) return null;

  const scored = releases.map(r => ({ release: r, score: spotlightScore(r) }));
  scored.sort((a, b) => b.score - a.score);

  // Log the top 3 so we can see the picker reasoning
  log.info("Spotlight picker scores (top 3):");
  for (const { release, score } of scored.slice(0, 3)) {
    console.log(
      `  ${score.toFixed(1).padStart(6)}  ${release.title.padEnd(36)} ${release.language.padEnd(10)}` +
      (release.imdbRating ? ` IMDb ${release.imdbRating}/${release.imdbVotes ?? 0}v` : " (unrated)")
    );
  }

  return scored[0].release;
}

// Gems below this TBSI are too weak to credibly call "hidden gems".
// Tunable: raise for a stricter shelf, lower for fuller decks.
export const GEM_MIN_TBSI = 6.5;
// Never let the floor starve the deck below this many — if too few clear it,
// the best-scored below-floor films backfill (and we warn).
const GEM_MIN_DECK = 5;

/**
 * Pick top-N hidden gems from a pool of releases.
 * Same scoring logic as spotlight, but returns N films instead of 1, excludes
 * any film in the exclude list, and applies a TBSI quality floor (minTbsi) so
 * weak titles don't get the "hidden gem" label. If too few clear the floor,
 * the best-scored below-floor films backfill the deck up to GEM_MIN_DECK
 * (and we warn), so a strict floor never starves the post.
 *
 * Gems MUST have a streaming platform — Mon Movement is "films worth pulling
 * up," so an unwatchable ("STREAMING TBA") pick breaks the premise. Filtered
 * out hard here, before scoring, so a high IMDb can never float a platformless
 * film onto the deck (the −30 penalty in hiddenGemScore couldn't guarantee it).
 */
export function pickHiddenGems(
  releases: Release[],
  count: number,
  excludeIds: Set<string> = new Set(),
  minTbsi: number = GEM_MIN_TBSI
): Release[] {
  const candidates = releases.filter(r => !excludeIds.has(r.id) && r.platform.length > 0);

  const scored = candidates
    .map(r => ({ release: r, score: hiddenGemScore(r) }))
    .sort((a, b) => b.score - a.score);

  const aboveFloor = scored.filter(s => (s.release.tbsiScore ?? 0) >= minTbsi);
  const belowFloor = scored.filter(s => (s.release.tbsiScore ?? 0) < minTbsi);

  const target = Math.min(count, GEM_MIN_DECK);
  let chosen = aboveFloor;
  if (aboveFloor.length < target) {
    const backfill = belowFloor.slice(0, target - aboveFloor.length);
    if (backfill.length > 0) {
      log.warn(
        `Gem floor TBSI ${minTbsi}: only ${aboveFloor.length} cleared it — ` +
        `backfilling ${backfill.length} below-floor film(s) to keep the deck at ${target}`
      );
    }
    chosen = [...aboveFloor, ...belowFloor.slice(0, target - aboveFloor.length)];
  }

  return chosen.slice(0, count).map(s => s.release);
}

function hiddenGemScore(r: Release): number {
  let score = 0;

  // Underserved languages still win, but smaller boost (Mon Movement is broader)
  if (UNDERSERVED.includes(r.language)) score += 30;
  else if (MAINSTREAM.includes(r.language)) score += 15;

  // IMDb signal — vote-weighted
  if (r.imdbRating !== undefined && r.imdbVotes !== undefined && r.imdbVotes > 0) {
    const voteWeight = Math.log10(r.imdbVotes + 1) / 5;
    score += r.imdbRating * voteWeight * 6;   // weighted higher for hidden gems
  }

  // STREAMING MATTERS HERE — hidden gem you can't watch isn't useful
  if (r.platform.length > 0) score += 25;
else score -= 30;  // films without a platform aren't useful for Mon Movement

  // Production signals
  if (r.director) score += 8;
  if (r.cast.length >= 2) score += 6;
  if (r.runtime && r.runtime >= 80) score += 3;

  // Synopsis depth
  if (r.synopsis.length > 200) score += 3;

  // Genre — these are the ones underserved cinemas typically win
  const STRONG_GENRES = ["Thriller", "Drama", "Mystery", "Crime", "Documentary"];
  if (r.genre.some(g => STRONG_GENRES.includes(g))) score += 4;

  // Deterministic tiebreaker
  const seed = r.id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  score += (seed % 100) / 100;

  return score;
}
