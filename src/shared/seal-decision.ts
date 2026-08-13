// src/shared/seal-decision.ts
// THE SEAL DECISION — one definition, three consumers.
//
// Extracted so the RENDERER (rendering/_shared.ts buildStampContext) and the
// LANDING VERIFIER (shared/post-validator.ts) can agree by construction rather
// than by convention. Before WD-042 they disagreed in both directions:
//   - the verifier warned "score shown with no real vote base" on Cocktail 2 /
//     Bharat Bhhagya Viddhaata / Heartin, whose cards had CORRECTLY printed NEW;
//   - and before WD-041-FIX-A the renderer printed the seal anyway.
// A predicate that lives in one module and is re-implemented in the other is a
// drift waiting to happen. It now lives here, and neither side owns it.
//
// It also has to live in a THIRD module, not in either consumer: post-validator
// imports the renderer's decision and the renderer imports the predicate, so
// putting it in either one closes an import cycle.

/**
 * A displayed score is only honest if a real audience produced it: at least one
 * recorded IMDb vote, or a TMDb community average with enough ballots behind it
 * to mean anything.
 *
 * The `>= 50` is the same number as _shared.ts's TMDB_FALLBACK_MIN_VOTES but is
 * deliberately NOT that constant: this gates score HONESTY, that one gates which
 * seal ART to use. They may diverge; keep them independently adjustable.
 */
export function hasRealVoteBase(film: { imdbVotes?: number; tmdbVoteCount?: number }): boolean {
  return (film.imdbVotes ?? 0) > 0 || (film.tmdbVoteCount ?? 0) >= 50;
}

/** The fields the seal decision reads. Structural, so both callers can pass their own shape. */
export type SealInput = {
  tbsiScore?: number;
  imdbVotes?: number;
  tmdbVoteAverage?: number;
  tmdbVoteCount?: number;
};

/**
 * Will this film's card print a NUMBER (a tbsi or tmdb seal), or the NEW/UNRATED
 * stamp? Mirrors buildStampContext's branch order exactly:
 *   1. tbsi  — a tbsiScore that ALSO clears hasRealVoteBase
 *   2. tmdb  — no blend, but a TMDb average with >= TMDB_FALLBACK_MIN_VOTES votes
 *   3. new   — everything else, i.e. no number on the card
 *
 * The verifier keys its score check off THIS, not off the raw data, so "the film
 * has a score in its record" and "the card shows a score" stop being confused.
 */
export function awardsNumericSeal(film: SealInput | undefined): boolean {
  if (!film) return false;
  if (film.tbsiScore !== undefined && hasRealVoteBase(film)) return true;
  return typeof film.tmdbVoteAverage === "number" && (film.tmdbVoteCount ?? 0) >= 50;
}
