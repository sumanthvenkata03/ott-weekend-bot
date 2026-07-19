// src/content/news/news-compose.ts
// NEWS DESK · E — the FORMAT decision. Pure rules over scores + poster reality.
//
// The format is a CONSEQUENCE of the day's confirmed material, never a target we
// fill. That inversion is the whole point: a desk that decides "carousel" first
// then hunts for four stories will pad. This decides last, and the WHY line is
// emitted verbatim so the reasoning ships with the output.
//
// Phase 2 replaces CAROUSEL/DIGEST with formats named after the published design
// system (spec §6.2), and makes the choice POSTER-AWARE (ruling R1):
//
//   jn-skin           a BIG single confirmed story that HAS A RESOLVED POSTER.
//                     The JN skin IS a full-bleed poster (§2.1) — it has no
//                     typographic fallback by design, so no poster ⇒ no jn-skin.
//   register          a BIG multi-item cluster (awards/lists, ≥3 items): cover +
//                     quadrant slides, clubbed by film, ×N seals for multi-wins.
//   register-single   ≥2 confirmed smaller stories: ONE 2×2 card, one story per
//                     quadrant. Mixes poster and maroon typographic quadrants.
//   none              <2 confirmed (N4, unchanged).
//
// Two guards live here because both failures are selection failures, not
// rendering ones:
//   • DISTINCT-STORY GUARD — the selected set may never contain two stories
//     whose headlines cluster together. Duplicate slots shipped once already.
//   • SUGGEST-ONLY SEGMENTS — IN MEMORIAM / RUMOR CHECK are classified and
//     reported, never selected into a rendered package in v1.

import type { VerifiedStory } from "./news-verify.js";
import type { ResolvedStory } from "./news-resolve.js";
import { BIG_SCORE_THRESHOLD, CLUSTER_MIN_OVERLAP, overlapRatio, titleTokens } from "./news-score.js";
import { isRenderable, segmentFor, type Segment } from "./segments.js";

export type EditionFormat = "jn-skin" | "register" | "register-single" | "none";

/** Confirmed stories needed before there is an edition at all (N4). */
export const MIN_STORIES_FOR_EDITION = 2;

/** Quadrants in a single register card, and per register slide. */
export const REGISTER_QUADRANTS = 4;

/** Items in a cluster at/above which it is a multi-item "list" story. */
export const MULTI_ITEM_MIN = 3;

export interface SelectedStory {
  resolved: ResolvedStory;
  segment: Segment;
  segmentReason: string;
}

export interface ComposedEdition {
  format: EditionFormat;
  /** Emitted verbatim into the package — the reasoning, not a label. */
  why: string;
  /** The lead story (jn-skin subject / register cover anchor). Null for none. */
  cover: SelectedStory | null;
  /** Stories that make the edition, in score order. Empty for none. */
  cards: SelectedStory[];
  /** Stories dropped at selection, with the reason. Reported, never silent. */
  dropped: { headline: string; reason: string }[];
}

const scoreOf = (r: ResolvedStory) => r.story.cluster.score;

/**
 * DISTINCT-STORY GUARD. Two stories whose headlines overlap at/above the
 * clustering threshold are THE SAME STORY that failed to cluster (different
 * languages, or a headline that drifted past the token threshold). Letting both
 * into one package produces the duplicate-slot bug: the same film twice, in two
 * quadrants, with two different framings.
 *
 * Asserted at SELECTION rather than after rendering, so the duplicate is dropped
 * before anything is built — and the drop is reported, never silent.
 */
export function selectDistinct(
  candidates: ResolvedStory[]
): { kept: ResolvedStory[]; dropped: { headline: string; reason: string }[] } {
  const kept: ResolvedStory[] = [];
  const keptTokens: Set<string>[] = [];
  const dropped: { headline: string; reason: string }[] = [];

  for (const cand of candidates) {
    const toks = titleTokens(cand.story.cluster.headline);
    const clashIdx = keptTokens.findIndex((t) => overlapRatio(toks, t) >= CLUSTER_MIN_OVERLAP);
    if (clashIdx >= 0) {
      dropped.push({
        headline: cand.story.cluster.headline,
        reason: `duplicate of "${kept[clashIdx]!.story.cluster.headline}" (overlap ≥ ${CLUSTER_MIN_OVERLAP})`,
      });
      continue;
    }
    // A resolved film already selected is also a duplicate, even when the
    // headlines read differently ("Balan The Boy" vs "Balan: The Boy Heads Home").
    const sameFilm = cand.film?.tmdbId
      ? kept.find((k) => k.film?.tmdbId === cand.film!.tmdbId)
      : undefined;
    if (sameFilm) {
      dropped.push({
        headline: cand.story.cluster.headline,
        reason: `same film as "${sameFilm.story.cluster.headline}" (TMDb ${cand.film!.tmdbId})`,
      });
      continue;
    }
    kept.push(cand);
    keptTokens.push(toks);
  }
  return { kept, dropped };
}

/** Attach the segment decision; drop suggest-only segments from the render set. */
function withSegments(
  rs: ResolvedStory[],
  env?: NodeJS.ProcessEnv
): { selected: SelectedStory[]; dropped: { headline: string; reason: string }[] } {
  const selected: SelectedStory[] = [];
  const dropped: { headline: string; reason: string }[] = [];
  for (const r of rs) {
    const { segment, reason } = segmentFor(r.story.cluster.storyClass, r.story.cluster.items.length);
    if (!isRenderable(segment, env)) {
      dropped.push({
        headline: r.story.cluster.headline,
        reason: `${segment.badge} is SUGGEST-ONLY in v1 — reported, not rendered`,
      });
      continue;
    }
    selected.push({ resolved: r, segment, segmentReason: reason });
  }
  return { selected, dropped };
}

/**
 * Decide the edition. `gatheredCount` feeds only the quiet-day line's honesty —
 * it never influences the format.
 */
export function composeEdition(
  resolved: ResolvedStory[],
  gatheredCount: number,
  env?: NodeJS.ProcessEnv
): ComposedEdition {
  const confirmed = resolved
    .filter((r) => r.story.confirmed)
    .sort((a, b) => scoreOf(b) - scoreOf(a));

  const distinct = selectDistinct(confirmed);
  const seg = withSegments(distinct.kept, env);
  const dropped = [...distinct.dropped, ...seg.dropped];
  const pool = seg.selected;

  // Rule 1 — N4. Not enough confirmed material is an outcome, not a failure.
  if (pool.length < MIN_STORIES_FOR_EDITION) {
    return {
      format: "none",
      why:
        `No edition today — ${gatheredCount} gathered, ${confirmed.length} confirmed, ` +
        `${pool.length} renderable (need ${MIN_STORIES_FOR_EDITION}).`,
      cover: null,
      cards: [],
      dropped,
    };
  }

  const lead = pool[0]!;
  const leadCluster = lead.resolved.story.cluster;
  const isBig = leadCluster.score >= BIG_SCORE_THRESHOLD;
  const itemCount = leadCluster.items.length;

  // Rule 2 — BIG multi-item cluster → the quadrant register.
  if (isBig && itemCount >= MULTI_ITEM_MIN) {
    return {
      format: "register",
      why:
        `REGISTER — "${leadCluster.headline}" scored ${leadCluster.score} ` +
        `(≥ ${BIG_SCORE_THRESHOLD}) across ${itemCount} items (≥ ${MULTI_ITEM_MIN}), so it is a LIST, ` +
        `not a single announcement. Cover + quadrant slides, clubbed by film. ` +
        `${pool.length} renderable of ${confirmed.length} confirmed.`,
      cover: lead,
      cards: pool,
      dropped,
    };
  }

  // Rule 3 — BIG single story WITH a poster → the JN skin.
  if (isBig && lead.resolved.film?.posterUrl) {
    return {
      format: "jn-skin",
      why:
        `JN-SKIN — "${leadCluster.headline}" scored ${leadCluster.score} (≥ ${BIG_SCORE_THRESHOLD}) ` +
        `as a single story, and resolved to a poster (${lead.resolved.film.confidence}: ` +
        `TMDb ${lead.resolved.film.tmdbId}). Poster-led single card.`,
      cover: lead,
      cards: [lead],
      dropped,
    };
  }

  // Rule 4 — everything else with ≥2 renderable → the single-card register.
  const cards = pool.slice(0, REGISTER_QUADRANTS);
  const overflow = pool.length - cards.length;
  const posterCount = cards.filter((c) => c.resolved.film?.posterUrl).length;
  const bigNoPoster = isBig && !lead.resolved.film?.posterUrl;
  return {
    format: "register-single",
    why:
      `REGISTER-SINGLE — ${pool.length} renderable stories, top score ${leadCluster.score}` +
      (bigNoPoster
        ? ` (BIG, but no poster resolved — the JN skin is poster-only by design, so it cannot lead)`
        : ` (< ${BIG_SCORE_THRESHOLD} BIG threshold)`) +
      `. One 2×2 card, ${posterCount} poster / ${cards.length - posterCount} typographic ` +
      `quadrant${cards.length - posterCount === 1 ? "" : "s"}` +
      (overflow > 0 ? `, ${overflow} to the "Also honoured." quadrant` : "") +
      `.`,
    cover: null,
    cards,
    dropped,
  };
}
