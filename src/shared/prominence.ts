// src/shared/prominence.ts
// Prominence ordering — PRESENTATION ORDER ONLY. "Biggest film first."
//
// The biggest film leads every carousel and every cover grid, irrespective of
// rating/verdict (e.g. a Ram Charan tent-pole leads even if it scores lower
// than a niche gem). Prominence = TMDb popularity (a live buzz signal), with
// vote_count then title as deterministic tie-breakers so equal-popularity
// films never reorder run-to-run.
//
// This is deliberately kept OUT of reconcile and the gate: filmFingerprint /
// computeDropHash never fold in order, and the gate runs BEFORE any content /
// render assembly — so re-sorting here can never move the --approve hash.

/** The only fields prominence ranks on. Release satisfies this structurally. */
export interface ProminenceFields {
  tmdbPopularity?: number;
  tmdbVoteCount?: number;
  title: string;
}

/**
 * Compare two films by prominence, most-prominent FIRST:
 *   1. tmdbPopularity DESC (missing → 0, so unranked films sink last)
 *   2. tmdbVoteCount  DESC (tie-break: the more-voted film leads)
 *   3. title          ASC  (final tie-break: fully deterministic)
 */
export function compareByProminence(a: ProminenceFields, b: ProminenceFields): number {
  const popA = a.tmdbPopularity ?? 0;
  const popB = b.tmdbPopularity ?? 0;
  if (popA !== popB) return popB - popA;                 // popularity DESC
  const votesA = a.tmdbVoteCount ?? 0;
  const votesB = b.tmdbVoteCount ?? 0;
  if (votesA !== votesB) return votesB - votesA;         // vote_count DESC
  return a.title.localeCompare(b.title);                 // title ASC
}

/** Return a NEW array sorted by prominence (input array is not mutated). */
export function sortByProminence<T extends ProminenceFields>(films: T[]): T[] {
  return [...films].sort(compareByProminence);
}
