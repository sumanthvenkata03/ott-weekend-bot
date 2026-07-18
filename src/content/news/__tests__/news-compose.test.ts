// NEWS DESK · E — the format decision. Pure rules, driven off fixtures.
import { describe, it, expect } from "vitest";
import { CAROUSEL_STORY_CAP, MIN_STORIES_FOR_EDITION, composeEdition } from "../news-compose.js";
import { BIG_SCORE_THRESHOLD } from "../news-score.js";
import type { ScoredCluster } from "../news-score.js";
import type { VerifiedStory } from "../news-verify.js";

const cluster = (id: string, score: number, headline = `story ${id}`): ScoredCluster => ({
  id,
  headline,
  language: "Tamil",
  items: [],
  outlets: ["The Hindu"],
  outletCount: 1,
  bestTier: "A",
  hasTierC: false,
  storyClass: "awards",
  classWeight: 4,
  suppressed: false,
  tierPoints: 3,
  crossOutletPoints: 0,
  judgedTitle: null,
  judgedPoints: 0,
  score,
  eligible: true,
  holdReason: "",
});

const story = (id: string, score: number, confirmed: boolean, headline?: string): VerifiedStory => ({
  cluster: cluster(id, score, headline),
  confirmed,
  sourceUrl: confirmed ? `https://thehindu.com/${id}` : "",
  basis: confirmed ? "confirmed by The Hindu" : "no primary outlet page found",
});

describe("composeEdition — N4 quiet day", () => {
  it("returns NONE with an honest count when nothing is confirmed", () => {
    const e = composeEdition([story("c1", 12, false), story("c2", 8, false)], 41);
    expect(e.format).toBe("NONE");
    expect(e.why).toBe("No edition today — 41 gathered, 0 confirmed (need 2).");
    expect(e.cards).toEqual([]);
    expect(e.cover).toBeNull();
  });

  it("returns NONE at exactly one confirmed story — no padding", () => {
    const e = composeEdition([story("c1", 14, true), story("c2", 9, false)], 30);
    expect(e.format).toBe("NONE");
    expect(e.why).toContain("30 gathered, 1 confirmed");
  });

  it("MIN_STORIES_FOR_EDITION stays the documented constant", () => {
    expect(MIN_STORIES_FOR_EDITION).toBe(2);
  });
});

describe("composeEdition — CAROUSEL", () => {
  it("a confirmed story at the BIG threshold leads a carousel", () => {
    const e = composeEdition(
      [story("c1", BIG_SCORE_THRESHOLD, true, "Raayan wins best Tamil film"), story("c2", 6, true)],
      44
    );
    expect(e.format).toBe("CAROUSEL");
    expect(e.cover?.cluster.id).toBe("c1");
    expect(e.cards).toHaveLength(1);
    expect(e.why).toContain("Raayan wins best Tamil film");
    expect(e.why).toContain(`≥ ${BIG_SCORE_THRESHOLD} BIG threshold`);
  });

  it("caps story cards at CAROUSEL_STORY_CAP, cover excluded", () => {
    const stories = [
      story("c1", 14, true),
      story("c2", 8, true),
      story("c3", 7, true),
      story("c4", 6, true),
      story("c5", 5, true),
      story("c6", 4, true),
      story("c7", 3, true),
    ];
    const e = composeEdition(stories, 60);
    expect(e.format).toBe("CAROUSEL");
    expect(e.cards).toHaveLength(CAROUSEL_STORY_CAP);
    expect(e.cards.map((c) => c.cluster.id)).toEqual(["c2", "c3", "c4", "c5"]);
  });

  it("ignores unconfirmed stories when picking the lead", () => {
    // A big UNCONFIRMED story must never become the cover (N1).
    const e = composeEdition([story("big", 99, false), story("c1", 6, true), story("c2", 5, true)], 40);
    expect(e.format).toBe("DIGEST");
    expect(e.cards.map((c) => c.cluster.id)).toEqual(["c1", "c2"]);
  });
});

describe("composeEdition — DIGEST", () => {
  it("two-plus confirmed stories below the BIG threshold make a digest", () => {
    const e = composeEdition([story("c1", BIG_SCORE_THRESHOLD - 1, true), story("c2", 5, true)], 33);
    expect(e.format).toBe("DIGEST");
    expect(e.cover).toBeNull();
    expect(e.cards).toHaveLength(2);
    expect(e.why).toContain(`< ${BIG_SCORE_THRESHOLD} BIG threshold`);
  });

  it("keeps every confirmed story in the digest, score-ordered", () => {
    const e = composeEdition([story("lo", 3, true), story("hi", 7, true), story("mid", 5, true)], 20);
    expect(e.format).toBe("DIGEST");
    expect(e.cards.map((c) => c.cluster.id)).toEqual(["hi", "mid", "lo"]);
  });
});
