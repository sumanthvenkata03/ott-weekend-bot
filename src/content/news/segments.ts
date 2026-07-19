// src/content/news/segments.ts
// NEWS DESK · A (Phase 2) — story class → editorial SEGMENT.
//
// The segment is what the reader sees ("TBSI RADAR", "THE BUZZ"); the class is
// what the scorer computed. Keeping them separate means the scoring table stays
// mechanical while the masthead stays editorial, and either can change without
// dragging the other.
//
// Deterministic, exported, and printable — the mapping IS the reasoning, so the
// Slack package can show why a story sits under the badge it does.

export type SegmentKey = "RADAR" | "BUZZ" | "REGISTER" | "IN_MEMORIAM" | "RUMOR_CHECK";

export interface Segment {
  key: SegmentKey;
  /** The badge printed on the card and the Slack line. */
  badge: string;
  /** Caption sign-off for this segment. */
  signoff: string;
  /**
   * SUGGEST-ONLY segments are classified and reported but never rendered
   * without an explicit owner go-ahead. Death notices are not automation's
   * call to make — a wrong or tasteless obituary card is unrecoverable.
   */
  suggestOnly: boolean;
}

export const SEGMENTS: Record<SegmentKey, Segment> = {
  RADAR: {
    key: "RADAR",
    badge: "TBSI RADAR",
    signoff: "TBSI RADAR — every big release, on your radar.",
    suggestOnly: false,
  },
  BUZZ: {
    key: "BUZZ",
    badge: "THE BUZZ",
    signoff: "THE BUZZ — what the industry is talking about.",
    suggestOnly: false,
  },
  REGISTER: {
    key: "REGISTER",
    badge: "TBSI REGISTER",
    signoff: "TBSI REGISTER — every category, every winner, on record.",
    suggestOnly: false,
  },
  IN_MEMORIAM: {
    key: "IN_MEMORIAM",
    badge: "IN MEMORIAM",
    signoff: "THE BIG SCREEN INDEX",
    suggestOnly: true, // v1 ships the suggestion path only
  },
  RUMOR_CHECK: {
    key: "RUMOR_CHECK",
    badge: "RUMOR CHECK",
    signoff: "RUMOR CHECK — we check before you share.",
    suggestOnly: true, // card format is v2
  },
};

/**
 * Class → segment. EDITABLE and exhaustive over the scorer's classes; anything
 * unlisted falls to BUZZ (a real story with no strong shape is still buzz).
 */
export const CLASS_TO_SEGMENT: Readonly<Record<string, SegmentKey>> = {
  "ott-date": "RADAR",
  "release-date": "RADAR",
  confirmation: "RADAR",
  boxoffice: "BUZZ",
  awards: "BUZZ", // promotes to REGISTER when the cluster is multi-item — see below
  trailer: "BUZZ",
  casting: "BUZZ",
  obituary: "IN_MEMORIAM",
  rumor: "RUMOR_CHECK",
  general: "BUZZ",
};

/** Items in an awards cluster at/above which it becomes a REGISTER, not BUZZ. */
export const REGISTER_PROMOTION_MIN_ITEMS = 3;

export interface SegmentDecision {
  segment: Segment;
  /** Printable one-liner: why this story landed in this segment. */
  reason: string;
}

/**
 * Decide the segment for one story. `itemCount` is the cluster's item count —
 * the only input beyond class, and only because a multi-item awards story is a
 * different editorial object (a list) than a single award headline.
 */
export function segmentFor(storyClass: string, itemCount: number): SegmentDecision {
  const baseKey = CLASS_TO_SEGMENT[storyClass] ?? "BUZZ";

  if (storyClass === "awards" && itemCount >= REGISTER_PROMOTION_MIN_ITEMS) {
    return {
      segment: SEGMENTS.REGISTER,
      reason: `class=awards with ${itemCount} items (≥ ${REGISTER_PROMOTION_MIN_ITEMS}) → REGISTER`,
    };
  }

  const segment = SEGMENTS[baseKey];
  const suffix = segment.suggestOnly ? " (SUGGEST-ONLY — not rendered)" : "";
  return {
    segment,
    reason: `class=${storyClass} → ${segment.badge}${suffix}`,
  };
}

/**
 * Whether a segment may actually be rendered into a card. IN_MEMORIAM is gated
 * behind an explicit env opt-in so the suggestion path can ship without the
 * automation ever publishing a death notice on its own judgement.
 */
export function isRenderable(segment: Segment, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!segment.suggestOnly) return true;
  if (segment.key === "IN_MEMORIAM") return env.OWNER_GO === "1";
  return false; // RUMOR_CHECK card format is v2 — never rendered in v1
}
