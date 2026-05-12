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