// WD-ENG-03 item 4 — THE OPERATOR APPROVES WHAT WILL RENDER.
//
// The review artifact's film line already showed the reconcile entry's platform
// STRING. That string is not what reaches the card: the seam writes only exact
// Platform members, so "Prime Video, SimplySouth, Lionsgate Play" produces TWO
// chips, not three. Approving a line that reads three and shipping two is the
// same class of gap as the defect this packet fixes — a value that means one
// thing in one field and another thing downstream.
//
// So the FILLED platforms appear in the review, next to the string they came
// from, together with anything that was skipped.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ createArgs: undefined as any, appendCalls: [] as any[] }));
vi.mock("@notionhq/client", () => ({
  Client: class {
    pages = { create: async (a: any) => { h.createArgs = a; return { id: "p1", url: "https://notion.example/p1" }; } };
    blocks = { children: { append: async (a: any) => { h.appendCalls.push(a); } } };
  },
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "x", NOTION_RELEASES_DB_ID: "db", SLACK_WEBHOOK_URL: "" },
}));

import { writeReview, WED_DROP_LABELS } from "../gate.js";
import { fillConfirmedPlatforms } from "../platform-seam.js";
import type { ReconciledFilm, ReconcileResult } from "../types.js";
import type { Platform, Release } from "../../shared/types.js";

function mk(title: string, tmdbId: number, platform: string, releasePlatform: Platform[] = []): ReconciledFilm {
  return {
    title, language: "Malayalam", pillar: "ott", tmdbId, platform,
    date: "2026-08-14", dateSource: "tmdb", foundIn: ["tmdb", "ai-net"],
    status: "confirmed", tier: "green", reasons: [],
    aiReview: { verdict: "confirm", reason: "…", trust: "confirmed", sourceDomainTrust: "allow" },
    release: {
      id: `tmdb-${tmdbId}`, tmdbId, title, language: "Malayalam", isSeries: false,
      platform: releasePlatform, releaseDate: "2026-08-14", releaseDates: { ott: "2026-08-14" },
      genre: ["Drama"], cast: [], synopsis: "x".repeat(120), subtitleLanguages: [],
      sources: ["tmdb"], fetchedAt: "2026-08-13T00:00:00.000Z",
      audioLanguages: { original: "Malayalam" },
    } as Release,
  } as ReconciledFilm;
}

const ott = (films: ReconciledFilm[]): ReconcileResult => ({
  pillar: "ott",
  window: { start: "2026-08-10", end: "2026-08-16" },
  reconciled: films,
  rejected: [],
  counts: { total: films.length, green: films.length, yellow: 0, red: 0, addedByAiNet: 0, flagged: 0 },
});

beforeEach(() => {
  h.createArgs = undefined;
  h.appendCalls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const reviewText = () => JSON.stringify(h.createArgs.children) + JSON.stringify(h.appendCalls);

describe("the filled platform is visible in the gate review artifact", () => {
  it("Kattalan's ManoramaMAX fill is named in the review the operator approves", async () => {
    const results = [ott([mk("Kattalan", 1065834, "ManoramaMAX")])];
    fillConfirmedPlatforms(results);

    await writeReview(results, "hash123", WED_DROP_LABELS);

    const text = reviewText();
    expect(text).toContain("Kattalan");
    expect(text).toContain("platform-seam: AI-review-confirmed → ManoramaMAX");
  });

  it("a partially-valid string shows what WILL render AND what was skipped", async () => {
    const results = [ott([mk("Aroopi", 1616268, "Prime Video, SimplySouth, Lionsgate Play")])];
    fillConfirmedPlatforms(results);

    await writeReview(results, "hash123", WED_DROP_LABELS);

    const text = reviewText();
    // What renders — two chips, in source order.
    expect(text).toContain("platform-seam: AI-review-confirmed → Prime Video, Lionsgate Play");
    // …and the token that will NOT appear on the card is named, not silently lost.
    expect(text).toContain("skipped");
    expect(text).toContain("SimplySouth");
  });

  it("a film the seam did not touch carries NO seam annotation", async () => {
    // Already populated upstream → ineligible → the review is byte-unchanged.
    const results = [ott([mk("Aroopi", 1616268, "Prime Video, SimplySouth, Lionsgate Play", ["Prime Video"])])];
    fillConfirmedPlatforms(results);

    await writeReview(results, "hash123", WED_DROP_LABELS);

    expect(reviewText()).not.toContain("platform-seam");
  });

  it("the review still renders normally when nothing was filled at all", async () => {
    const results = [ott([mk("Kattalan", 1065834, "ManoramaMAX", ["ManoramaMAX"])])];
    await writeReview(results, "hash123", WED_DROP_LABELS);
    const text = reviewText();
    expect(text).toContain("Kattalan");
    expect(text).not.toContain("platform-seam");
  });
});
