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

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WD-046-SEAL — is this an OTT ARRIVAL rather than a premiere?
 *
 * True when the film played theatrically STRICTLY BEFORE the OTT date it is
 * being carded for. Both dates must be ISO yyyy-mm-dd, which makes the string
 * comparison a correct chronological one and rejects anything malformed rather
 * than comparing garbage.
 *
 * Deliberately excludes two shapes that look similar and are not:
 *   · no theatrical date at all — a direct-to-OTT premiere (Pyaar Prema
 *     Kalyanam), and a manual add with no rating record at all (Srinivasa
 *     Mangapuram). Both are genuinely new to everyone.
 *   · a theatrical date AFTER the OTT date — a film streaming before it opens
 *     in cinemas (I'm Game, theatrical 2026-09-03 vs OTT 2026-08-20). Nothing
 *     has had a run yet, so there is no verdict to inherit.
 */
export function isOttArrival(
  rel: { releaseDates?: { theatrical?: string; ott?: string } } | undefined
): boolean {
  const t = rel?.releaseDates?.theatrical;
  const o = rel?.releaseDates?.ott;
  if (typeof t !== "string" || typeof o !== "string") return false;
  if (!ISO.test(t) || !ISO.test(o)) return false;
  return t < o;
}

/**
 * WD-046-SEAL — does a Wed Drop card wear the RATINGS SEAL instead of NEW?
 *
 * The operator's rule, and both halves are required:
 *   (a) it is an OTT arrival (isOttArrival), and
 *   (b) it has a real vote base (hasRealVoteBase — the ENG-10 floor, UNWEAKENED).
 *
 * THE THEATRICAL EDITION IS ALWAYS NEW. Every film in that deck opens inside the
 * window by construction, so there is no prior run for an audience to have
 * scored — a seal there would be borrowed from a different release entirely.
 * This is an explicit branch rather than an emergent one: today no theatrical
 * film HAS a vote base, so the two are indistinguishable in behaviour, and the
 * moment one did (a re-release, a festival title) the emergent version would
 * quietly start printing scores on premiere cards.
 *
 * Returning false does NOT blank the seal — the caller falls back to the NEW
 * stamp, which is a seal in its own right. Nothing is ever fabricated: this
 * predicate only decides WHICH honest state to show.
 */
export function wearsArrivalSeal(
  edition: string,
  rel: (SealInput & { releaseDates?: { theatrical?: string; ott?: string } }) | undefined
): boolean {
  if (edition !== "ott") return false;
  if (!rel) return false;
  return isOttArrival(rel) && hasRealVoteBase(rel);
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
