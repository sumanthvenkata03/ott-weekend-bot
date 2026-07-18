// src/content/news/news-compose.ts
// NEWS DESK · E — the FORMAT decision. Pure rules over scores, no LLM, no I/O.
//
// The format is a CONSEQUENCE of the day's confirmed material, never a target we
// fill. That inversion is the whole point: a desk that decides "carousel" first
// then hunts for four stories will pad. This decides last, and the WHY line is
// emitted verbatim into the Slack draft so the reasoning ships with the output.
//
// N4 (quiet-day honesty) is the FIRST rule, not a fallback: fewer than two
// confirmed stories is a legitimate, publishable-as-nothing outcome.

import type { VerifiedStory } from "./news-verify.js";
import { BIG_SCORE_THRESHOLD } from "./news-score.js";

export type EditionFormat = "CAROUSEL" | "DIGEST" | "NONE";

/** Confirmed stories needed before there is an edition at all (N4). */
export const MIN_STORIES_FOR_EDITION = 2;

/** Story cards in a carousel, excluding the cover. */
export const CAROUSEL_STORY_CAP = 4;

export interface ComposedEdition {
  format: EditionFormat;
  /** Emitted verbatim into the draft — the reasoning, not a label. */
  why: string;
  /** The lead story (carousel cover). Null for DIGEST/NONE. */
  cover: VerifiedStory | null;
  /** Stories that make the edition, in score order. Empty for NONE. */
  cards: VerifiedStory[];
}

/**
 * Decide the edition. `gatheredCount` is passed only so the quiet-day line can
 * report honestly ("N gathered, M confirmed") — it never influences the format.
 */
export function composeEdition(
  verified: VerifiedStory[],
  gatheredCount: number
): ComposedEdition {
  const confirmed = verified
    .filter((v) => v.confirmed)
    .sort((a, b) => b.cluster.score - a.cluster.score);

  // Rule 1 — N4. Not enough confirmed material is an outcome, not a failure.
  if (confirmed.length < MIN_STORIES_FOR_EDITION) {
    return {
      format: "NONE",
      why: `No edition today — ${gatheredCount} gathered, ${confirmed.length} confirmed (need ${MIN_STORIES_FOR_EDITION}).`,
      cover: null,
      cards: [],
    };
  }

  // Rule 2 — a BIG confirmed story earns the carousel and leads it.
  const big = confirmed[0]!;
  if (big.cluster.score >= BIG_SCORE_THRESHOLD) {
    const cards = confirmed.slice(1, 1 + CAROUSEL_STORY_CAP);
    return {
      format: "CAROUSEL",
      why:
        `CAROUSEL — "${big.cluster.headline}" scored ${big.cluster.score} ` +
        `(≥ ${BIG_SCORE_THRESHOLD} BIG threshold: class=${big.cluster.storyClass}, ` +
        `tier=${big.cluster.bestTier}, ${big.cluster.outletCount} outlets). ` +
        `Cover + ${cards.length} story card${cards.length === 1 ? "" : "s"} ` +
        `(cap ${CAROUSEL_STORY_CAP}), from ${confirmed.length} confirmed.`,
      cover: big,
      cards,
    };
  }

  // Rule 3 — enough confirmed material, no single story big enough to lead.
  return {
    format: "DIGEST",
    why:
      `DIGEST — ${confirmed.length} confirmed stories, top score ${big.cluster.score} ` +
      `(< ${BIG_SCORE_THRESHOLD} BIG threshold), so no story leads. Single card.`,
    cover: null,
    cards: confirmed,
  };
}
