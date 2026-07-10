// verify.test.ts — the shared verifyCandidates surface. runAiNet + annotateWithAiReview
// are mocked (offline); the reconcile core runs REAL so tiers/reject-buckets/assessDates
// are genuinely exercised. tmdb.js is mocked so importing verify (liveDeps) opens no SQLite.
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ aiNet: { films: [] as unknown[], rejected: [] as unknown[], dateConflict: [] as unknown[] } }));
vi.mock("../ai-net.js", () => ({ runAiNet: vi.fn(async () => h.aiNet) }));
vi.mock("../ai-review.js", () => ({ annotateWithAiReview: vi.fn(async (r: unknown) => r) }));
// liveDeps in verify.ts imports tmdb.js — mock it so importing verify stays offline.
vi.mock("../../ingestion/releases/tmdb.js", () => ({
  searchTitleTmdb: vi.fn(async () => ({ movie: [], tv: [] })),
  getCreditsAndLanguages: vi.fn(async () => ({ leadCast: [] })),
}));

import { verifyCandidates } from "../verify.js";
import { RECONCILE_LANGUAGES } from "../run.js";
import { runAiNet } from "../ai-net.js";
import { annotateWithAiReview } from "../ai-review.js";
import type { Release } from "../../shared/types.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { ReconcileDeps } from "../reconcile.js";
import type { ExtractedFilm } from "../types.js";

const OTT_WIN: BucketWindow = { start: "2026-06-22", end: "2026-06-28", dateField: "ott", label: "Now Streaming" };

function makeRelease(p: Partial<Release> & { tmdbId: number; title: string }): Release {
  return {
    id: `tmdb-${p.tmdbId}`,
    language: "Tamil",
    isSeries: false,
    platform: [],
    releaseDate: "2026-06-25",
    genre: [],
    cast: [],
    synopsis: "",
    subtitleLanguages: [],
    sources: ["tmdb"],
    fetchedAt: "2026-06-23T00:00:00.000Z",
    ...p,
  };
}
function ai(p: Partial<ExtractedFilm> & { title: string }): ExtractedFilm {
  return { isSeries: false, sources: [{ url: `https://news/${encodeURIComponent(p.title)}` }], ...p };
}
const noDeps: ReconcileDeps = {
  searchTitle: async () => ({ movie: [], tv: [] }),
  fetchCredits: async () => ({ leadCast: [] }),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.aiNet = { films: [], rejected: [], dateConflict: [] };
});

describe("verifyCandidates — composes AI net + reconcile core", () => {
  it("tiers a pool film by window.dateField and routes an AI series to the reject bucket", async () => {
    h.aiNet = { films: [ai({ title: "Some Show", isSeries: true })], rejected: [], dateConflict: [] };
    // platform set so the OTT-no-platform warn doesn't fire — isolates the window check.
    const pool = [makeRelease({ tmdbId: 1, title: "PoolFilm", platform: ["Netflix"], releaseDates: { ott: "2026-06-25" } })];

    const result = await verifyCandidates(pool, { pillar: "ott", window: OTT_WIN, deps: noDeps });

    expect(result.pillar).toBe("ott");
    expect(result.reconciled).toHaveLength(1);
    expect(result.reconciled[0]!.landingStatus).toBe("pass"); // ott date in window
    expect(result.reconciled[0]!.tier).toBe("yellow");          // pass but single-net (tmdb only)
    expect(result.rejected).toHaveLength(1); // the AI series, rejected (not tiered)
    expect(runAiNet).toHaveBeenCalledWith("ott", expect.any(Array), OTT_WIN);
  });

  it("🔒 aiReview defaults OFF — annotateWithAiReview is NOT called", async () => {
    await verifyCandidates([makeRelease({ tmdbId: 1, title: "X" })], { pillar: "ott", window: OTT_WIN, deps: noDeps });
    expect(annotateWithAiReview).not.toHaveBeenCalled();
  });

  it("aiReview:true → annotateWithAiReview runs on the single result", async () => {
    const result = await verifyCandidates([makeRelease({ tmdbId: 1, title: "X" })], { pillar: "ott", window: OTT_WIN, aiReview: true, deps: noDeps });
    expect(annotateWithAiReview).toHaveBeenCalledTimes(1);
    expect(annotateWithAiReview).toHaveBeenCalledWith([result]);
  });

  it("🔒 language align (5a): the default AI-net corroboration set is the active 7 (find-7/verify-7, Bengali trimmed)", () => {
    expect(RECONCILE_LANGUAGES).toHaveLength(7);
    expect(RECONCILE_LANGUAGES).toEqual(expect.arrayContaining(["Marathi", "Punjabi"]));
    expect(RECONCILE_LANGUAGES).not.toContain("Bengali");
  });
});
