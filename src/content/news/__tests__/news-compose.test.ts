// NEWS DESK · E (Phase 2) — poster-aware format choice + the two selection
// guards. Pure rules, driven off fixtures.
import { describe, it, expect } from "vitest";
import {
  MIN_STORIES_FOR_EDITION,
  REGISTER_QUADRANTS,
  composeEdition,
  selectDistinct,
} from "../news-compose.js";
import { BIG_SCORE_THRESHOLD } from "../news-score.js";
import type { ScoredCluster } from "../news-score.js";
import type { VerifiedStory } from "../news-verify.js";
import type { ResolvedStory, ResolvedFilm } from "../news-resolve.js";
import type { NewsItem } from "../news-gather.js";

const item = (title: string): NewsItem => ({
  title, url: "https://news.google.com/x" + title.length, source: "The Hindu",
  publishedISO: "2026-07-19T06:00:00.000Z", language: "Tamil",
});

/**
 * Distinct real-shaped headlines. Generic fixtures ("headline c1", "headline
 * c2") overlap at 0.5 and are correctly eaten by the distinct-story guard —
 * fixtures for a dedupe guard must be genuinely different stories.
 */
const HEADLINES = [
  "Balan The Boy locks its ZEE5 streaming date",
  "Maa Inti Bangaaram closes a theatrical run",
  "Raayan takes Best Tamil Film at the National Awards",
  "Vijay's next begins a Chennai schedule",
  "Kalki 2898 AD sequel enters pre-production",
  "Feminichi Fathima opens across Kerala multiplexes",
  "Committee Kurrollu adds a make-up honour",
  "Srikanth heads for a Hindi belt re-release",
];
let headlineCursor = 0;
const nextHeadline = () => HEADLINES[headlineCursor++ % HEADLINES.length]!;

const cluster = (id: string, over: Partial<ScoredCluster> = {}): ScoredCluster => ({
  id,
  headline: nextHeadline(),
  language: "Tamil",
  items: [item(id)],
  outlets: ["The Hindu", "Cinema Express"],
  outletCount: 2,
  bestTier: "A",
  hasTierC: false,
  storyClass: "ott-date",
  classWeight: 4,
  suppressed: false,
  tierPoints: 3,
  crossOutletPoints: 1,
  judgedTitle: null,
  judgedPoints: 0,
  score: 8,
  eligible: true,
  holdReason: "",
  ...over,
});

const story = (id: string, over: Partial<ScoredCluster> = {}, confirmed = true): VerifiedStory => ({
  cluster: cluster(id, over),
  confirmed,
  sourceUrl: confirmed ? `https://thehindu.com/${id}` : "",
  basis: confirmed ? `The Hindu confirms ${id}` : "no primary outlet page found",
});

const res = (
  id: string,
  film: ResolvedFilm | null = null,
  over: Partial<ScoredCluster> = {},
  confirmed = true
): ResolvedStory => ({
  story: story(id, over, confirmed),
  film,
  reason: film ? `resolved ${film.title}` : "no title detected — typographic",
});

const withPoster = (title: string, tmdbId = 111): ResolvedFilm => ({
  title, confidence: "quoted", tmdbId, posterUrl: `https://image.tmdb.org/t/p/w500/${tmdbId}.jpg`,
});

import { beforeEach } from "vitest";
beforeEach(() => { headlineCursor = 0; });

describe("composeEdition — N4 quiet day", () => {
  it("returns none when nothing is confirmed", () => {
    const e = composeEdition([res("c1", null, {}, false), res("c2", null, {}, false)], 41);
    expect(e.format).toBe("none");
    expect(e.why).toContain("41 gathered, 0 confirmed");
    expect(e.cards).toEqual([]);
  });

  it("returns none at exactly one confirmed story — no padding", () => {
    const e = composeEdition([res("c1"), res("c2", null, {}, false)], 30);
    expect(e.format).toBe("none");
    expect(MIN_STORIES_FOR_EDITION).toBe(2);
  });
});

describe("composeEdition — jn-skin is POSTER-ONLY (ruling R1)", () => {
  const big = { score: BIG_SCORE_THRESHOLD + 2, items: [item("solo")] };

  it("a BIG single story WITH a poster leads the JN skin", () => {
    const e = composeEdition([res("big", withPoster("Balan The Boy"), big), res("c2")], 44);
    expect(e.format).toBe("jn-skin");
    expect(e.cover?.resolved.film?.title).toBe("Balan The Boy");
    expect(e.why).toContain("resolved to a poster");
  });

  it("the SAME story WITHOUT a poster cannot lead — falls to register-single", () => {
    // The JN skin IS a full-bleed poster; it has no typographic fallback.
    const e = composeEdition([res("big", null, big), res("c2")], 44);
    expect(e.format).toBe("register-single");
    expect(e.why).toContain("no poster resolved");
  });
});

describe("composeEdition — register vs register-single", () => {
  it("a BIG multi-item cluster becomes the quadrant register", () => {
    const many = { score: BIG_SCORE_THRESHOLD + 1, storyClass: "awards", items: [item("a"), item("b"), item("c"), item("d")] };
    const e = composeEdition([res("awards", null, many), res("c2"), res("c3")], 60);
    expect(e.format).toBe("register");
    expect(e.why).toContain("is a LIST");
  });

  it("two-plus smaller stories become the single-card register", () => {
    const e = composeEdition([res("c1"), res("c2"), res("c3")], 33);
    expect(e.format).toBe("register-single");
    expect(e.cards.length).toBeLessThanOrEqual(REGISTER_QUADRANTS);
  });

  it("counts poster vs typographic quadrants in the WHY line", () => {
    const e = composeEdition([res("c1", withPoster("A", 1)), res("c2"), res("c3")], 33);
    expect(e.why).toMatch(/1 poster \/ 2 typographic quadrants/);
  });

  it("caps quadrants at 4 and reports the overflow", () => {
    const e = composeEdition(
      ["a", "b", "c", "d", "e", "f"].map((k, i) => res(k, null, { score: 8 - i })),
      70
    );
    expect(e.cards).toHaveLength(REGISTER_QUADRANTS);
    expect(e.why).toContain("Also honoured.");
  });
});

// ── §B DISTINCT-STORY GUARD — the duplicate-slot bug ────────────────────────

describe("selectDistinct — the duplicate-Lenin fixture", () => {
  // Two real-shaped headlines for the SAME film that did not cluster upstream.
  const L1 = "'Lenin' OTT release: when and where to watch the Tamil drama";
  const L2 = "'Lenin' OTT release date confirmed — where to watch the Tamil drama";

  it("drops the second copy of the same story, with a stated reason", () => {
    const { kept, dropped } = selectDistinct([
      res("l1", null, { headline: L1 }),
      res("l2", null, { headline: L2 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("duplicate of");
  });

  it("never lets both copies into a composed package", () => {
    const e = composeEdition(
      [res("l1", null, { headline: L1 }), res("l2", null, { headline: L2 }), res("other")],
      40
    );
    const headlines = e.cards.map((c) => c.resolved.story.cluster.headline);
    expect(headlines.filter((h) => h.includes("Lenin"))).toHaveLength(1);
    expect(e.dropped.some((d) => d.reason.includes("duplicate"))).toBe(true);
  });

  it("also dedupes on RESOLVED FILM when the headlines read differently", () => {
    const { kept, dropped } = selectDistinct([
      res("a", withPoster("Balan The Boy", 42), { headline: "Balan The Boy locks its OTT date" }),
      res("b", withPoster("Balan The Boy", 42), { headline: "Where to stream Chidambaram's psychological thriller" }),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped[0]!.reason).toContain("same film");
  });

  it("keeps two genuinely different stories", () => {
    const { kept, dropped } = selectDistinct([
      res("a", null, { headline: "Raayan wins Best Tamil Film at the National Awards" }),
      res("b", null, { headline: "Balan The Boy locks its ZEE5 streaming date" }),
    ]);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
  });
});

// ── SUGGEST-ONLY segments never render in v1 ───────────────────────────────

describe("composeEdition — suggest-only segments", () => {
  it("drops an obituary from the render set and says why", () => {
    const e = composeEdition(
      [res("ob", null, { storyClass: "obituary" }), res("c1"), res("c2")],
      40,
      {} as NodeJS.ProcessEnv // OWNER_GO unset
    );
    expect(e.cards.some((c) => c.resolved.story.cluster.storyClass === "obituary")).toBe(false);
    expect(e.dropped.some((d) => d.reason.includes("SUGGEST-ONLY"))).toBe(true);
  });

  it("renders an obituary only when OWNER_GO=1", () => {
    const e = composeEdition(
      [res("ob", null, { storyClass: "obituary" }), res("c1"), res("c2")],
      40,
      { OWNER_GO: "1" } as NodeJS.ProcessEnv
    );
    expect(e.cards.some((c) => c.resolved.story.cluster.storyClass === "obituary")).toBe(true);
  });

  it("drops a rumor story — the RUMOR CHECK card format is v2", () => {
    const e = composeEdition(
      [res("r", null, { storyClass: "rumor" }), res("c1"), res("c2")],
      40,
      { OWNER_GO: "1" } as NodeJS.ProcessEnv
    );
    expect(e.cards.some((c) => c.resolved.story.cluster.storyClass === "rumor")).toBe(false);
  });
});
