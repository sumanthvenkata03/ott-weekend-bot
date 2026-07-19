// NEWS DESK — the INDIA-SCOPE GATE (Mastul's lesson, news edition).
// Deterministic, pre-verification, fail-open. Pure: no API is called.
import { describe, it, expect } from "vitest";
import {
  FOREIGN_SCOPE_MARKERS,
  INDIA_SCOPE_MARKERS,
  clusterItems,
  indiaScope,
  scoreClusters,
} from "../news-score.js";
import type { NewsItem } from "../news-gather.js";

const GN = "https://news.google.com/rss/articles/CBM";
const item = (title: string, source: string): NewsItem => ({
  title, url: `${GN}${title.length}${source.length}`, source,
  publishedISO: "2026-07-19T06:00:00.000Z", language: "Telugu",
});
const noJudged = () => null;

describe("indiaScope — admits Indian cinema", () => {
  it("admits on a language marker", () => {
    const v = indiaScope("Telugu star signs a new film");
    expect(v.inScope).toBe(true);
    expect(v.reason).toContain("Indian marker");
  });

  it("admits on an industry marker", () => {
    expect(indiaScope("Kollywood gears up for a big release").inScope).toBe(true);
    expect(indiaScope("Sandalwood veteran begins shoot").inScope).toBe(true);
  });

  it("admits on an Indian platform/trade marker", () => {
    expect(indiaScope("The thriller heads to ZEE5 next month").inScope).toBe(true);
    expect(indiaScope("Nizam rights sold for 37 crore").inScope).toBe(true);
  });

  it("admits when the OUTLET is the Indian signal", () => {
    // Outlets are appended to the scope text by the scorer.
    expect(indiaScope("Some film locks a date 123telugu").inScope).toBe(true);
  });
});

describe("indiaScope — excludes exclusively foreign stories", () => {
  it("REGRESSION — the Plastic Beauty K-drama headline lands OUT of scope", () => {
    const v = indiaScope("Plastic Beauty: the new K-drama everyone is streaming this month");
    expect(v.inScope).toBe(false);
    expect(v.reason).toContain("foreign marker");
  });

  it("excludes other exclusively-foreign industries", () => {
    expect(indiaScope("A Korean film sweeps the festival circuit").inScope).toBe(false);
    expect(indiaScope("Hollywood studio announces a slate").inScope).toBe(false);
    expect(indiaScope("Bangladeshi drama premieres in Dhaka").inScope).toBe(false);
  });

  it("a foreign marker does NOT exclude when an Indian marker is also present", () => {
    // A Telugu remake of a Korean film is Indian-cinema news.
    const v = indiaScope("Telugu remake of the Korean drama goes on floors");
    expect(v.inScope).toBe(true);
  });
});

describe("indiaScope — FAILS OPEN", () => {
  it("a borderline pan-India story with no marker stays IN", () => {
    const v = indiaScope("The Paradise sets a landmark theatrical deal");
    expect(v.inScope).toBe(true);
    expect(v.reason).toContain("fail-open");
  });

  it("says so explicitly — the editor is the final gate", () => {
    expect(indiaScope("An unremarkable industry note").reason).toContain("editor decides");
  });
});

describe("scope gate wiring — held BEFORE verification", () => {
  it("an out-of-scope cluster is ineligible and never spends a slot", () => {
    const clusters = clusterItems([
      item("Plastic Beauty: the new K-drama everyone is streaming", "Some Outlet"),
    ]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.eligible).toBe(false);
    expect(s!.holdReason).toContain("out of scope — not Indian cinema");
  });

  it("a Telugu OTT story with a Tier-A outlet stays eligible", () => {
    const clusters = clusterItems([
      item("Telugu drama locks its OTT release date", "123telugu.com"),
    ]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.eligible).toBe(true);
    expect(s!.holdReason).toBe("");
  });

  it("scope is checked BEFORE the tier floor — the reason names scope, not tier", () => {
    // A single untiered outlet would also fail the tier floor; scope wins the
    // reason because it is the cheaper, more fundamental disqualification.
    const clusters = clusterItems([item("Korean drama tops the charts", "Random Blog")]);
    const [s] = scoreClusters(clusters, [], noJudged);
    expect(s!.holdReason).toContain("out of scope");
    expect(s!.holdReason).not.toContain("tier floor");
  });

  it("both marker lists are non-empty and editable", () => {
    expect(INDIA_SCOPE_MARKERS.length).toBeGreaterThan(15);
    expect(FOREIGN_SCOPE_MARKERS.length).toBeGreaterThan(5);
  });
});
