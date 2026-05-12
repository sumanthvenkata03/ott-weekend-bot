// src/content/weekend/compare-picker.ts
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";

/**
 * Score a single release for compare-worthiness.
 * We want films with REAL production signal — director, cast, runtime —
 * not stubs that TMDb has barely populated.
 */
function compareCandidacy(r: Release): number {
  let score = 0;
  
  // Production signals (strongest when present, but often missing for upcoming films)
  if (r.director) score += 15;
  if (r.cast.length >= 3) score += 10;
  else if (r.cast.length >= 1) score += 4;
  if (r.runtime && r.runtime >= 80) score += 5;
  
  // IMDb signal — vote-weighted
  if (r.imdbRating !== undefined && r.imdbVotes !== undefined && r.imdbVotes > 0) {
    const voteWeight = Math.log10(r.imdbVotes + 1) / 5;
    score += r.imdbRating * voteWeight * 4;
  }
  
  // Synopsis depth — counts more now because it's often the only signal pre-release
  if (r.synopsis.length > 100) score += 4;
  if (r.synopsis.length > 250) score += 4;
  if (r.synopsis.length > 450) score += 4;
  
  // Streaming
  if (r.platform.length > 0) score += 5;
  
  // Genre signal
  const STRONG_GENRES = ["Thriller", "Drama", "Action", "Crime", "Romance", "Mystery"];
  if (r.genre.some(g => STRONG_GENRES.includes(g))) score += 3;
  
  // Has a poster — TMDb stubs often don't have one; real films do
  if (r.posterUrl) score += 3;
  
  return score;
}

/**
 * Score a pair of releases for face-off energy.
 * Higher = better compare post.
 */
function pairScore(a: Release, b: Release): number {
  let score = compareCandidacy(a) + compareCandidacy(b);
  
  // BIG BONUS for distinct languages — Hindi vs Telugu, Tamil vs Malayalam etc. is the sharpest compare
  if (a.language !== b.language) score += 25;
  
  // SMALL BONUS for distinct genres — Romance vs Thriller is sharper than two thrillers
  const aGenres = new Set(a.genre);
  const bGenres = new Set(b.genre);
  const overlap = [...aGenres].filter(g => bGenres.has(g)).length;
  if (overlap === 0 && aGenres.size > 0 && bGenres.size > 0) score += 8;
  else if (overlap === 1) score += 3;
  // Total overlap (2+) gets no bonus — film festivals next to each other are boring
  
  // SMALL BONUS for one being streaming + one being theatrical pending — that's an "OTT vs theatre" frame
  // (deferred — we don't track theatrical-vs-OTT cleanly yet)
  
  return score;
}

/**
 * Pick the two films most worth comparing this weekend.
 * Returns null if no pair clears the quality threshold —
 * we'd rather skip the Thu Compare than ship a weak one.
 */
export function pickFaceOff(
  releases: Release[],
  minPairScore: number = 35
): [Release, Release] | null {
  if (releases.length < 2) return null;
  
  // Compare candidacy filter — drop films that don't even meet a baseline
  const candidates = releases.filter(r => compareCandidacy(r) >= 8);
  if (candidates.length < 2) {
    log.warn(`Compare: only ${candidates.length} candidates pass production-signal filter`);
    return null;
  }
  
  // Score every pair
  type Pair = { a: Release; b: Release; score: number };
  const pairs: Pair[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      pairs.push({
        a: candidates[i],
        b: candidates[j],
        score: pairScore(candidates[i], candidates[j]),
      });
    }
  }
  
  pairs.sort((p1, p2) => p2.score - p1.score);
  
  // Log top 3 pairs for visibility
  log.info("Face-off picker — top pairs:");
  for (const p of pairs.slice(0, 3)) {
    console.log(
      `  ${p.score.toFixed(1).padStart(6)}  ${p.a.title.slice(0, 22).padEnd(22)} (${p.a.language})  vs  ` +
      `${p.b.title.slice(0, 22).padEnd(22)} (${p.b.language})`
    );
  }
  
  const winner = pairs[0];
  if (winner.score < minPairScore) {
    log.warn(`Top pair scored ${winner.score.toFixed(1)} — below threshold ${minPairScore}. Skipping.`);
    return null;
  }
  
  return [winner.a, winner.b];
}