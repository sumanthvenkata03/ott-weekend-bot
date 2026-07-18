// NEWS DESK · C — class matcher, outlet tiering, clustering, scoring, and the
// R2 eligibility floor. Every headline fixture below is a REAL item pulled from
// the live Google News feed on 2026-07-18 (the Phase-0 sample), with the
// " - Outlet" suffix stripped exactly as news-gather does.
import { describe, it, expect } from "vitest";
import {
  BIG_SCORE_THRESHOLD,
  CLUSTER_MIN_OVERLAP,
  classify,
  clusterItems,
  overlapRatio,
  scoreClusters,
  tierOfOutlet,
  titleTokens,
  TIER_FLOOR_BROAD_OUTLETS,
} from "../news-score.js";
import type { NewsItem } from "../news-gather.js";
import type { JudgedFilm } from "../../../jobs/reddit-radar.js";

/** Google News always hands us a redirect stub — the realistic url shape. */
const GN = "https://news.google.com/rss/articles/CBMiK2h0dHBzOi8vZXhhbXBsZQ";

const item = (title: string, source: string, extra: Partial<NewsItem> = {}): NewsItem => ({
  title,
  url: `${GN}${title.length}`,
  source,
  publishedISO: "2026-07-18T12:00:00.000Z",
  language: "Tamil",
  ...extra,
});

const noJudged = () => null;

// ── R3 · suppressors ─────────────────────────────────────────────────────────

describe("classify — listicle suppressor (R3)", () => {
  it("suppresses weekly round-up listicles", () => {
    for (const t of [
      "OTT Releases This Week (18th July to 24th July)",
      "This Week's South OTT Releases: What to Watch",
      "New OTT releases to watch this weekend: 10 new movies & shows on Netflix, Prime Video, JioHotstar & more",
      "Friday OTT releases for this week (July 17, 2026): 'Desire', 'Maa Inti Bangaaram', 'The East Palace' lead",
      "Your South Indian OTT Guide: 6 New Films To Watch This Week",
    ]) {
      const c = classify(t);
      expect(c.suppressed, `should suppress: ${t}`).toBe(true);
      expect(c.name).toBe("listicle");
    }
  });

  it("suppresses the Mshale-style SEO listicle", () => {
    const c = classify(
      "12 Best OTT Movies You Should Watch In Telugu | Prime Video, Netflix, Sonyliv, Jiohotstar, Zee5 Jared Mccain (jWqatAzGiu)"
    );
    expect(c.suppressed).toBe(true);
    expect(c.name).toBe("listicle");
  });

  it("suppresses date-range wraps and web-series catalogue pages", () => {
    expect(
      classify("Latest Malayalam, Tamil, Telugu, Kannada OTT releases (July 13 - July 19): Maa Inti Bangaaram to The Devil").suppressed
    ).toBe(true);
    expect(
      classify("New Kannada OTT Release Movies 2026: Latest Kannada Movies & Web Series Streaming Online").suppressed
    ).toBe(true);
  });
});

describe("classify — roundup suppressor (R3)", () => {
  it("suppresses Twitter/audience-reaction pieces", () => {
    const c = classify("'Oh..! Sukumari' Twitter review: Thiruveer and Aishwarya Rajesh win praise; viewers call it 'An entertain");
    expect(c.suppressed).toBe(true);
    expect(c.name).toBe("roundup");
  });

  it("suppresses a roundup even when it also looks like a real class", () => {
    // "Arulvaan Twitter review ... wins praise" would otherwise match `awards`
    // on "wins". Suppressors run FIRST — that ordering is the guarantee.
    const c = classify("'Arulvaan' Twitter review: Arulnithi's performance wins praise; fans call it 'A soulful drama movie with");
    expect(c.name).toBe("roundup");
    expect(c.suppressed).toBe(true);
  });
});

describe("classify — real story classes", () => {
  it("tags the National Film Awards cluster as awards", () => {
    const c = classify("72nd National Film Awards for 2024: Dhanush's Raayan wins best Tamil film");
    expect(c.name).toBe("awards");
    expect(c.suppressed).toBe(false);
  });

  it("REGRESSION — 'National Awards' without the word Film is still awards", () => {
    // The real headline the 2026-07-18 shadow run misclassified as `general(1)`,
    // costing the day's edition its CAROUSEL. Outlets drop "Film" freely.
    const c = classify("72nd National Awards: Complete list of winners is here");
    expect(c.name).toBe("awards");
    expect(c.weight).toBe(4);
    expect(c.suppressed).toBe(false);
  });

  it("matches the singular 'National Award' too", () => {
    expect(classify("Committee Kurrollu bags a National Award").name).toBe("awards");
  });

  it("tags OTT 'when and where to watch' as ott-date", () => {
    expect(classify("Maa Inti Bangaaram on OTT: When and where to watch Samantha Ruth Prabhu's Telugu actioner?").name)
      .toBe("ott-date");
  });

  it("tags a theatrical date announcement as release-date", () => {
    expect(classify("Lokesh Kanagaraj, Wamiqa Gabbi starrer 'DC' to release on this date").name)
      .toBe("release-date");
  });

  it("does NOT mistake a headline ending in 'online' for a catalogue page", () => {
    // The listicle regex matches "streaming online", never a bare "online" —
    // this real headline is a genuine OTT-date story and must survive.
    const c = classify("Balan The Boy OTT Release: When and where to watch Chidambaram's psychological drama thriller online");
    expect(c.suppressed).toBe(false);
    expect(c.name).toBe("ott-date");
  });

  it("falls back to `general` with weight 1", () => {
    const c = classify("Some outlet publishes an unremarkable industry note");
    expect(c.name).toBe("general");
    expect(c.weight).toBe(1);
    expect(c.suppressed).toBe(false);
  });
});

// ── Outlet tiering (name-primary) ────────────────────────────────────────────

describe("tierOfOutlet", () => {
  it("tiers off the SOURCE NAME because the url is always a Google redirect", () => {
    expect(tierOfOutlet(GN, "The Hindu")).toBe("A");
    expect(tierOfOutlet(GN, "Cinema Express")).toBe("A");
    expect(tierOfOutlet(GN, "The New Indian Express")).toBe("A");
    expect(tierOfOutlet(GN, "Gulte")).toBe("A");
  });

  it("never lets the news.google.com host itself match a registry", () => {
    // Guards the failure mode where every item tiers identically off the stub.
    expect(tierOfOutlet(GN, "Mshale")).toBe("B");
    expect(tierOfOutlet(GN, "UpNext by Reelgood")).toBe("B");
  });

  it("still reads a real host when one is present", () => {
    expect(tierOfOutlet("https://www.thehindu.com/entertainment/x.ece", "")).toBe("A");
    expect(tierOfOutlet("https://indian.community/x", "")).toBe("C");
  });
});

// ── Clustering ───────────────────────────────────────────────────────────────

describe("titleTokens / overlapRatio", () => {
  it("singularizes so wins/win and awards/award cluster", () => {
    const t = titleTokens("Raayan Wins Best Tamil Film at National Awards");
    expect(t.has("win")).toBe(true);
    expect(t.has("award")).toBe(true);
    expect(t.has("film")).toBe(false); // stopword
  });

  it("scores overlap against the SHORTER headline, not the union", () => {
    const a = titleTokens("72nd National Film Awards for 2024: Dhanush's Raayan wins best Tamil film");
    const b = titleTokens("Raayan Wins Best Tamil Film at National Awards");
    expect(overlapRatio(a, b)).toBe(1);
  });

  it("is 0 for disjoint headlines", () => {
    expect(overlapRatio(titleTokens("Box office collections cross 100 crore"), titleTokens("Trailer out now"))).toBe(0);
  });
});

describe("clusterItems", () => {
  it("clusters the real National Film Awards coverage into ONE story", () => {
    const items = [
      item("72nd National Film Awards for 2024: Dhanush's Raayan wins best Tamil film", "Cinema Express"),
      item("72nd National Film Awards: Mammootty, Dhanush and Amaran win big from South", "India Today"),
      item("Raayan Wins Best Tamil Film at National Awards", "Gulte"),
      item("72nd National Film Awards | 'Raayan,' 'Amaran' bag top honours; 'Meiyazhagan' and 'Maharaja' miss marquee categories", "The Hindu"),
    ];
    const clusters = clusterItems(items);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.items).toHaveLength(4);
    expect(clusters[0]!.outlets).toEqual(["Cinema Express", "India Today", "Gulte", "The Hindu"]);
  });

  it("keeps an unrelated story in its own cluster", () => {
    const clusters = clusterItems([
      item("72nd National Film Awards for 2024: Dhanush's Raayan wins best Tamil film", "Cinema Express"),
      item("Maa Inti Bangaaram on OTT: When and where to watch Samantha Ruth Prabhu's Telugu actioner?", "Pinkvilla"),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it("picks the highest-tier item as the cluster headline", () => {
    const clusters = clusterItems([
      item("Raayan Wins Best Tamil Film at National Awards", "Mshale"),
      item("72nd National Film Awards | 'Raayan,' 'Amaran' bag top honours", "The Hindu"),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.headline).toContain("bag top honours"); // The Hindu, Tier A
  });

  it("CLUSTER_MIN_OVERLAP stays the documented constant", () => {
    expect(CLUSTER_MIN_OVERLAP).toBe(0.45);
  });
});

// ── Scoring + the R2 eligibility floor ───────────────────────────────────────

describe("scoreClusters", () => {
  it("prints every input that moved the number", () => {
    const clusters = clusterItems([
      item("72nd National Film Awards for 2024: Dhanush's Raayan wins best Tamil film", "Cinema Express"),
      item("72nd National Film Awards: Mammootty, Dhanush and Amaran win big from South", "India Today"),
      item("Raayan Wins Best Tamil Film at National Awards", "Gulte"),
      item("72nd National Film Awards | 'Raayan,' 'Amaran' bag top honours", "The Hindu"),
    ]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s).toMatchObject({
      storyClass: "awards",
      classWeight: 4,
      bestTier: "A",
      tierPoints: 3,
      outletCount: 4,
      crossOutletPoints: 3,
      judgedPoints: 0,
      eligible: true,
    });
    expect(s!.score).toBe(4 + 3 + 3); // class + tier + cross-outlet
  });

  it("a Tier-A anchored awards cluster with broad coverage clears the BIG threshold", () => {
    const outlets = ["Cinema Express", "India Today", "Gulte", "The Hindu", "DT Next", "Moneycontrol.com"];
    const clusters = clusterItems(
      outlets.map((o) => item("72nd National Film Awards: Raayan wins best Tamil film", o))
    );
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.outletCount).toBe(6);
    expect(s!.crossOutletPoints).toBe(4); // saturates at MAX_CROSS_OUTLET_BONUS
    expect(s!.score).toBe(4 + 3 + 4);
    expect(s!.score).toBeGreaterThanOrEqual(BIG_SCORE_THRESHOLD);
  });

  it("R3/R2 — the untiered single-outlet SEO story is excluded by the tier floor", () => {
    const clusters = clusterItems([item("How to watch Maa Inti Bangaram in the US", "UpNext by Reelgood")]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.bestTier).toBe("B");
    expect(s!.outletCount).toBe(1);
    expect(s!.eligible).toBe(false);
    expect(s!.holdReason).toContain("below tier floor");
  });

  it("a suppressed cluster is ineligible and scores 0 no matter who ran it", () => {
    // The Hindu (Tier A) publishing a listicle still does not make it news.
    const clusters = clusterItems([item("OTT Releases This Week (18th July to 24th July)", "The Hindu")]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.score).toBe(0);
    expect(s!.eligible).toBe(false);
    expect(s!.holdReason).toBe("suppressed class: listicle");
  });

  it("broad multi-outlet coverage clears the floor without a Tier-A anchor", () => {
    const clusters = clusterItems(
      ["Filmibeat", "Pinkvilla", "Sakshi Post"].map((o) =>
        item("Balan The Boy OTT Release: When and where to watch the thriller", o)
      )
    );
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.bestTier).toBe("B");
    expect(s!.outletCount).toBe(TIER_FLOOR_BROAD_OUTLETS);
    expect(s!.eligible).toBe(true);
  });

  it("a Tier-C anchor blocks the broad-coverage path", () => {
    const clusters = clusterItems([
      item("Some film gets a streaming date confirmed by the studio", "indian.community"),
      item("Some film gets a streaming date confirmed by the studio", "Filmibeat"),
      item("Some film gets a streaming date confirmed by the studio", "Pinkvilla"),
    ]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.hasTierC).toBe(true);
    expect(s!.eligible).toBe(false);
    expect(s!.holdReason).toContain("Tier-C anchor");
  });

  it("awards the judged-film bonus and names the film", () => {
    const judged: JudgedFilm[] = [
      { title: "Raayan", star: 4, verdict: "Worth a Try", source: "verdict" } as JudgedFilm,
    ];
    const findJudged = (title: string, films: JudgedFilm[]) =>
      films.find((f) => title.toLowerCase().includes(f.title.toLowerCase())) ?? null;
    const clusters = clusterItems([item("Raayan Wins Best Tamil Film at National Awards", "The Hindu")]);
    const [s] = scoreClusters(clusters, judged, findJudged);
    expect(s!.judgedTitle).toBe("Raayan");
    expect(s!.judgedPoints).toBe(2);
  });

  it("sorts by score descending with a total, reproducible tie-break", () => {
    const clusters = clusterItems([
      item("Some minor industry note about a producer", "Filmibeat"),
      item("72nd National Film Awards: Raayan wins best Tamil film", "The Hindu"),
    ]);
    const scored = scoreClusters(clusters, [], noJudged);
    expect(scored[0]!.storyClass).toBe("awards");
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });
});
