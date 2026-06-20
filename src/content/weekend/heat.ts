// src/content/weekend/heat.ts
// HEAT axis (🔥) — a DISPLAY-ONLY attention/anticipation signal shown alongside the
// verdict. Heat measures buzz/popularity, NOT quality, and NEVER touches the
// verdict: a Skip can run hot, a Must Watch can be quiet. It is computed HERE from
// the film's free popularity signals, in complete isolation from the verdict
// pipeline — this module is PURE and is NOT imported by verdict-research.ts /
// computeVerdictScore / scoreResearch. Nothing here can move ★, the verdict tier,
// the cap, the gate, or the critic median.

/** Structural subset of Release — the ONLY fields heat reads, all attention/volume
 *  (never quality: tmdbVoteAverage/critic ratings are deliberately absent). Release
 *  satisfies this; fixtures pass a literal. */
export interface HeatInput {
  tmdbPopularity?: number;  // TMDb's attention metric — the primary heat signal
  tmdbVoteCount?: number;   // engagement volume
  imdbVotes?: number;       // engagement volume
}

export interface Heat {
  /** 0-100 attention score. DISPLAY-ONLY — never feeds any verdict math. */
  score: number;
  /** Absolute band label. */
  label: "HIGH BUZZ" | "WARM" | "QUIET";
}

// ── FIXED, ABSOLUTE dials — NEVER derived from the current slate ─────────────
// Chosen so the labels carry absolute meaning across weeks: a genuinely quiet week
// can read all QUIET, a blockbuster week all HIGH BUZZ. They are constants in code,
// never a per-run percentile. (Sanity-checked against the live tmdbPopularity
// distribution in the verify step; if a known-popular film mislabels, the CONSTANT
// is adjusted — it stays a fixed value.)
//
// POP_REF: the tmdbPopularity at which popularity alone saturates normPop → 1.0
// (popPart 100, before any vote bonus). 100 is a "very popular release" line for
// this pan-Indian + regional catalogue.
const POP_REF = 100;
/** Engagement-volume bonus: total votes (imdb + tmdb) add up to +VOTE_BONUS_MAX on
 *  top of the popularity score, saturating at VOTE_REF votes. At release week votes
 *  are ~0, so this is ~0 and popularity carries heat. */
const VOTE_BONUS_MAX = 15;
const VOTE_REF = 50_000;
/** Absolute band cutoffs on the 0-100 score. */
const HOT_HIGH = 66; // ≥ → "HIGH BUZZ"
const HOT_WARM = 33; // ≥ → "WARM"; else "QUIET"

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
/** Log-normalize a non-negative value to 0-1 against a reference (ref → ~1.0). */
const logNorm = (value: number, ref: number): number =>
  clamp01(Math.log10(value + 1) / Math.log10(ref + 1));

/**
 * Compute the display Heat for a film from its free popularity signals — or `null`
 * when there is NO signal at all (popularity absent AND zero votes). PURE.
 *
 * ABSENCE vs QUIET (visible failure): `null` means "we have no attention data" →
 * the card renders NO heat sticker. "QUIET" means a real, present, low signal →
 * the sticker shows. They are DIFFERENT states; a missing signal must NEVER fall
 * back to a default 0 / QUIET.
 */
export function computeHeat(film: HeatInput): Heat | null {
  const pop = typeof film.tmdbPopularity === "number" ? film.tmdbPopularity : null;
  const votes =
    (typeof film.imdbVotes === "number" ? film.imdbVotes : 0) +
    (typeof film.tmdbVoteCount === "number" ? film.tmdbVoteCount : 0);

  // No attention signal whatsoever → ABSENT (render nothing), never a default QUIET.
  if (pop === null && votes === 0) return null;

  const popPart = pop === null ? 0 : Math.round(100 * logNorm(pop, POP_REF));
  const voteBonus = votes === 0 ? 0 : Math.round(VOTE_BONUS_MAX * logNorm(votes, VOTE_REF));
  const score = Math.max(0, Math.min(100, popPart + voteBonus));
  const label: Heat["label"] = score >= HOT_HIGH ? "HIGH BUZZ" : score >= HOT_WARM ? "WARM" : "QUIET";
  return { score, label };
}
