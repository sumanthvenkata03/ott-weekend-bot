// src/content/archives/copy-guard.ts
//
// Archives' binding of THE shared Name Sweep (src/shared/copy-guard.ts).
//
// The ⚠ SCHEDULED DUPLICATE ⚠ this file used to carry is GONE: the tokenizer,
// n-gram/trigger regexes and strict-backing check now live in one place, shared
// with Wed Drop and the News Desk. What remains here is the only part that was
// ever Archives-specific — its non-person vocabulary and its Release→allowlist
// shape.
//
// Backing-set semantics are unchanged (ruling R2c): a swept person-name is
// backed only when ALL its name-tokens are a subset of ONE film's cast / crew /
// director / composer full name. Film data only — there is no self-report to
// launder (Archives copy is a single why-line per card, not an LLM name list),
// so the sweep reads the real text directly. This catches both an invented name
// AND a misspelled real credit (the "Govindh" for "Govind" class — {govindh} is
// not a subset of {govind}).

import type { Release } from "../../shared/types.js";
import { buildAllowlist, type NameAllowlist } from "../../shared/copy-guard.js";

// Re-exported so existing importers (and the fixtures) keep their entry points.
export { nameTokens, sweepNames, type NameAllowlist } from "../../shared/copy-guard.js";

/**
 * Titlecased words that are NOT people: pillar boilerplate + join words +
 * streaming brands. A swept run made only of these is filler, never a name.
 *
 * ARCHIVES-SPECIFIC — deliberately not merged with Wed Drop's or News'. Adding
 * a word here makes one more token count as filler, which makes the guard
 * LOOSER; the lists stay per-pillar so no site inherits another's blind spots.
 */
export const ARCHIVES_NON_PERSON_WORDS: readonly string[] = [
  "the", "this", "that", "these", "now", "new", "our", "your", "one", "which",
  "tonight", "weekend", "week", "weeks", "streaming", "stream", "watch", "watching",
  "archive", "archives", "vintage", "classic", "classics", "gem", "gems", "missed",
  "must", "binge", "again", "still", "years", "year", "ago", "back", "then", "now",
  "in", "on", "at", "of", "and", "or", "for", "with", "to", "from", "a", "an",
  "starring", "featuring", "alongside", "feat", "directed", "director", "dir",
  "comedy", "drama", "thriller", "action", "romance", "horror", "crime", "mystery",
  "fantasy", "adventure", "family", "musical", "war", "western", "history", "sport",
  "telugu", "tamil", "malayalam", "kannada", "hindi", "bengali", "marathi", "punjabi",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // Streaming brands
  "netflix", "prime", "video", "hotstar", "disney", "jiocinema", "jiohotstar",
  "jio", "sonyliv", "sony", "liv", "zee5", "zee", "aha", "hoichoi", "sunnxt",
  "sun", "nxt", "mubi", "lionsgate", "apple", "tv", "manoramamax", "max", "chaupal",
];

/** Build the per-film allowlist: every real person's token-set + all non-person filler. */
export function buildArchivesNameAllowlist(releases: Release[]): NameAllowlist {
  const personNames: (string | undefined)[] = [];
  const nonPersonText: (string | undefined)[] = [];
  for (const r of releases) {
    personNames.push(...(r.cast ?? []), ...(r.leadCast ?? []), r.director, r.musicDirector);
    nonPersonText.push(r.title, ...r.platform, r.language);
  }
  return buildAllowlist({
    personNames,
    nonPersonText,
    nonPersonWords: ARCHIVES_NON_PERSON_WORDS,
  });
}
