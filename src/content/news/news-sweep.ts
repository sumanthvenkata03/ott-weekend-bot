// src/content/news/news-sweep.ts
// The News Desk's binding of THE shared Name Sweep (src/shared/copy-guard.ts).
//
// ── WHAT BACKS A NEWS NAME (ruling R5) ───────────────────────────────────────
// Wed Drop and Archives back names against FILM DATA (cast/crew rows). The News
// Desk has no film rows — a story is a headline, a set of outlets, and a
// verification basis line. So the backing corpus is the selected clusters' OWN
// TEXT: every confirmed headline + every verification basis line + every outlet
// name. A person named in the caption must already appear in the material the
// story was built from. Anything else is the model adding a person to the news,
// which is the exact failure this guard exists to stop.
//
// Consequence worth stating plainly: this corpus is PROSE, not a roster, so
// every capitalized run in it becomes a "person". That is deliberate and errs
// safe — the guard's job is to reject names with NO textual provenance, not to
// adjudicate who is a person. A name the sources printed is allowed; a name
// they never printed is not.
//
// ── SOURCE-TRUNCATED NAMES ARE NOT VIOLATIONS ────────────────────────────────
// When an outlet itself prints a short form ("Kartik" where the full name is
// Kartik Aaryan), the short form IS in the corpus and backs itself. The caption
// prompt asks for full names and to keep the source's form when that is all the
// source gives — a prompt concern, never a guard failure.

import type { VerifiedStory } from "./news-verify.js";
import { buildAllowlist, sweepNames, type NameAllowlist } from "../../shared/copy-guard.js";

export { sweepNames } from "../../shared/copy-guard.js";

/**
 * NEWS-SPECIFIC non-person vocabulary. Drafted from the class keywords the
 * scorer already matches on plus the furniture that showed up in the first real
 * captions (segment sign-offs, CTA words, platform names, trade-figure words).
 *
 * Deliberately NOT merged with Wed Drop's or Archives' lists: every word added
 * makes one more token count as filler, which makes the guard LOOSER.
 */
export const NEWS_NON_PERSON_WORDS: readonly string[] = [
  // Determiners / joins / boilerplate
  "the", "this", "that", "these", "those", "now", "new", "our", "your", "one",
  "which", "what", "when", "where", "who", "how", "today", "tonight", "week",
  "weekend", "day", "days", "here", "out", "up", "in", "on", "at", "of", "and",
  "or", "for", "with", "to", "from", "a", "an", "is", "are", "was", "were",
  // Desk furniture / CTA / sign-offs
  "tbsi", "radar", "buzz", "register", "memoriam", "rumor", "rumour", "check",
  "index", "screen", "big", "desk", "edition", "sources", "source", "link",
  "links", "bio", "comments", "comment", "swipe", "save", "share", "follow",
  "read", "more", "full", "list", "complete", "every", "all", "per", "confirmed",
  "reports", "reported", "according", "via", "story", "stories", "news", "update",
  // Story-class keywords (mirrors the scorer's matchers)
  "ott", "release", "released", "releases", "streaming", "stream", "watch",
  "premiere", "debut", "digital", "theatrical", "theatres", "theaters", "date",
  "box", "office", "collection", "collections", "crore", "worldwide", "gross",
  "lifetime", "estimated", "trailer", "teaser", "first", "look", "glimpse",
  "poster", "motion", "award", "awards", "national", "film", "films", "best",
  "winner", "winners", "won", "wins", "honours", "honors", "category",
  "casting", "cast", "star", "starring", "featuring", "alongside", "feat",
  "director", "directed", "dir", "producer", "music", "obituary", "passes",
  "away", "demise", "movie", "movies", "series", "web", "show", "actor",
  "actress", "trade", "reportedly", "talks", "buzzing",
  // Languages / industries
  "telugu", "tamil", "malayalam", "kannada", "hindi", "bengali", "marathi",
  "punjabi", "indian", "india", "bollywood", "tollywood", "kollywood",
  "mollywood", "sandalwood", "south", "north", "pan",
  // Days / months
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  // Streaming brands
  "netflix", "prime", "video", "hotstar", "disney", "jiocinema", "jiohotstar",
  "jio", "sonyliv", "sony", "liv", "zee5", "zee", "aha", "hoichoi", "sunnxt",
  "sun", "nxt", "mubi", "lionsgate", "apple", "tv", "manoramamax", "max",
  "chaupal", "youtube",
];

/**
 * Build the caption allowlist from the stories the caption is allowed to use.
 * Headlines, basis lines and outlet names are ALL person-backing text: a name
 * printed by the sources backs itself.
 */
export function buildNewsNameAllowlist(stories: VerifiedStory[]): NameAllowlist {
  const personNames: string[] = [];
  for (const s of stories) {
    personNames.push(s.cluster.headline, s.basis, ...s.cluster.outlets);
    for (const item of s.cluster.items) personNames.push(item.title);
  }
  return buildAllowlist({
    personNames,
    nonPersonText: [],
    nonPersonWords: NEWS_NON_PERSON_WORDS,
  });
}

/**
 * Sweep a drafted caption against its own stories. Returns unbacked names;
 * empty ⇒ clean. The caller retries once, then holds the caption.
 */
export function sweepCaption(caption: string, stories: VerifiedStory[]): string[] {
  return sweepNames(caption, buildNewsNameAllowlist(stories));
}
