// src/reconcile/__tests__/ai-review.test.ts
// OFFLINE tests for annotateWithAiReview — the ADVISORY attach step. The LLM
// transport is mocked, so these are deterministic and never touch the
// network/CLI. They lock the authority boundary of ANNOTATE: it changes no tier,
// demotes NOTHING (enforcement is a separate pass — see auto-demote.test.ts),
// never feeds the hash, computes the Phase-1 trust fields in code, and fails soft
// toward MORE caution. Run: npx vitest run --dir src/reconcile
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
// Stateful in-memory cache mock — proves the determinism spine: a re-run with the
// SAME reviewer input HITS the cache (no second LLM call). cache.js otherwise
// opens real SQLite at import; mocking it keeps the suite offline + deterministic.
const cacheMock = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("../../shared/cache.js", () => ({
  cached: async (key: string, loader: () => Promise<unknown>) => {
    if (cacheMock.store.has(key)) return cacheMock.store.get(key);
    const v = await loader();
    cacheMock.store.set(key, v);
    return v;
  },
}));
import { callClaudeJSON } from "../../content/claude.js";
import { annotateWithAiReview, buildReviewPrompt, classifyDomainTrust } from "../ai-review.js";
import { computeDropHash } from "../gate.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";

const mockCall = vi.mocked(callClaudeJSON);

function film(p: { tmdbId?: number; title: string; tier: "green" | "yellow" | "red" } & Partial<ReconciledFilm>): ReconciledFilm {
  return {
    language: "Tamil", pillar: "theatrical", dateSource: "tmdb",
    foundIn: ["tmdb", "ai-net"], status: "confirmed", reasons: [],
    ...p,
  } as ReconciledFilm;
}
/** Minimal Release stub for seam-#3 platform-fill tests (only `platform` matters). */
function rel(platform: string[]): NonNullable<ReconciledFilm["release"]> {
  return {
    id: "tmdb-x", title: "X", language: "Tamil", isSeries: false,
    platform, releaseDate: "2026-06-25", genre: [], cast: [],
    synopsis: "", subtitleLanguages: [], sources: [], fetchedAt: "",
  } as NonNullable<ReconciledFilm["release"]>;
}
function result(films: ReconciledFilm[], pillar: "theatrical" | "ott" = "theatrical"): ReconcileResult {
  return {
    pillar,
    window: { start: "2026-06-24", end: "2026-06-28" },
    reconciled: films,
    rejected: [],
    counts: {
      total: films.length,
      green: films.filter((f) => f.tier === "green").length,
      yellow: films.filter((f) => f.tier === "yellow").length,
      red: films.filter((f) => f.tier === "red").length,
      addedByAiNet: 0,
      flagged: 0,
    },
  };
}

beforeEach(() => {
  mockCall.mockReset();
  cacheMock.store.clear();
});

describe("annotateWithAiReview — advisory attach, hash-invariant, no demotion", () => {
  it("attaches verdicts + trust fields by tmdbId, leaves tiers untouched, and does NOT change the hash", async () => {
    const films = [
      film({ tmdbId: 1, title: "Kashmir 1947", tier: "green" }),
      film({ tmdbId: 2, title: "Sardar 2", tier: "yellow" }),
      film({ tmdbId: 3, title: "Unverified Lead", tier: "red", status: "unverified", foundIn: ["ai-net"] }),
    ];
    const results = [result(films)];
    const before = computeDropHash(results);
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "trade press confirms the date", sourceUrl: "https://www.thehindu.com/kashmir" },
        { tmdbId: 2, verdict: "doubt", reason: "one source contests the date", sourceUrl: "https://news.example/sardar" },
      ],
    });

    await annotateWithAiReview(results);

    expect(computeDropHash(results)).toBe(before);          // annotate never moves the hash (no demotion here)
    expect(films[0]!.tier).toBe("green");                   // tier untouched
    expect(films[0]!.aiReview?.verdict).toBe("confirm");
    expect(films[0]!.aiReview?.trust).toBe("confirmed");    // allowlisted source → confirmed
    expect(films[0]!.aiReview?.sourceDomainTrust).toBe("allow");
    expect(films[1]!.aiReview?.verdict).toBe("doubt");
    expect(films[1]!.aiReview?.trust).toBe("unconfirmed");  // doubt → unconfirmed
    expect(films[0]!.aiDemoted).toBeUndefined();            // annotate demotes NOTHING
    expect(films[1]!.aiDemoted).toBeUndefined();
    expect(films[2]!.aiReview).toBeUndefined();             // 🔴 skipped (gate-excluded already)
    expect(mockCall).toHaveBeenCalledTimes(1);              // ONE batched call for the edition
  });

  it("trust mapping: reject → contradicted; confirm → confirmed; denylist-only confirm → unconfirmed (code overrides LLM)", async () => {
    const films = [
      film({ tmdbId: 1, title: "Rejected", tier: "green" }),
      film({ tmdbId: 2, title: "Confirmed", tier: "green" }),
      film({ tmdbId: 3, title: "Piracy-sourced", tier: "green" }),
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "reject", reason: "cancelled per trade", sourceUrl: "https://variety.com/x" },
        { tmdbId: 2, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.pinkvilla.com/x" },
        { tmdbId: 3, verdict: "confirm", reason: "date per aggregator", sourceUrl: "https://mlsbd.tv/some-film" },
      ],
    });
    await annotateWithAiReview(results);
    expect(films[0]!.aiReview?.trust).toBe("contradicted");
    expect(films[1]!.aiReview?.trust).toBe("confirmed");
    expect(films[2]!.aiReview?.sourceDomainTrust).toBe("deny");
    expect(films[2]!.aiReview?.trust).toBe("unconfirmed");   // a piracy-only "confirm" is NOT trusted
  });

  it("downgrades a doubt/reject with NO sourceUrl to unverified (no bare authoritative claim) → trust unconfirmed", async () => {
    const films = [film({ tmdbId: 5, title: "Sourceless", tier: "green" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 5, verdict: "reject", reason: "seems off" }] });
    await annotateWithAiReview(results);
    expect(films[0]!.aiReview?.verdict).toBe("unverified");
    expect(films[0]!.aiReview?.sourceUrl).toBeUndefined();
    expect(films[0]!.aiReview?.trust).toBe("unconfirmed");
  });

  it("CACHE determinism: a re-run with the same input HITS the cache — same verdict, NO second LLM call", async () => {
    const mk = (): ReconcileResult[] => [result([film({ tmdbId: 1, title: "Postponed", tier: "green" })])];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 1, verdict: "reject", reason: "postponed to July", sourceUrl: "https://news.example/postponed" }] });

    const first = mk();
    await annotateWithAiReview(first);
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(first[0]!.reconciled[0]!.aiReview?.trust).toBe("contradicted");

    const second = mk();
    await annotateWithAiReview(second);
    expect(mockCall).toHaveBeenCalledTimes(1);                       // STILL one — re-run read the cache
    expect(second[0]!.reconciled[0]!.aiReview?.trust).toBe("contradicted");
  });

  it("fail-soft: a failed/garbled review call marks every reviewed film 'unavailable' with NO trust (uncertain, never a pass)", async () => {
    const films = [film({ tmdbId: 7, title: "X", tier: "green" }), film({ tmdbId: 8, title: "Y", tier: "yellow" })];
    const results = [result(films)];
    mockCall.mockResolvedValue(undefined as unknown as { reviews: never[] });
    await annotateWithAiReview(results);
    expect(films.every((f) => f.aiReview?.verdict === "unavailable")).toBe(true);
    expect(films.every((f) => f.aiReview?.trust === undefined)).toBe(true);   // no trust ⇒ enforcement skips it
    expect(films[0]!.aiReview?.reason).toMatch(/verify manually/);
  });

  it("a film the model omits is marked unverified (trust unconfirmed), not silently blank", async () => {
    const films = [film({ tmdbId: 9, title: "Returned", tier: "green" }), film({ tmdbId: 10, title: "Omitted", tier: "green" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 9, verdict: "confirm", reason: "ok", sourceUrl: "https://x.example" }] });
    await annotateWithAiReview(results);
    expect(films[1]!.aiReview?.verdict).toBe("unverified");
    expect(films[1]!.aiReview?.trust).toBe("unconfirmed");
    expect(films[1]!.aiReview?.reason).toMatch(/not returned/);
  });

  it("two editions ⇒ exactly two batched calls (≤2/drop); an all-🔴 edition makes none", async () => {
    const t = result([film({ tmdbId: 1, title: "T", tier: "green" })], "theatrical");
    const o = result([film({ tmdbId: 2, title: "O", tier: "yellow", pillar: "ott" })], "ott");
    mockCall.mockResolvedValue({ reviews: [] });
    await annotateWithAiReview([t, o]);
    expect(mockCall).toHaveBeenCalledTimes(2);

    mockCall.mockReset();
    const redOnly = result([film({ tmdbId: 3, title: "R", tier: "red", status: "unverified", foundIn: ["ai-net"] })]);
    mockCall.mockResolvedValue({ reviews: [] });
    await annotateWithAiReview([redOnly]);
    expect(mockCall).toHaveBeenCalledTimes(0);             // no 🟢/🟡 ⇒ no call
  });
});

describe("annotateWithAiReview — seam #3 platform fact-fill + platformAgrees (OTT-gated, fill-only-if-empty)", () => {
  it("platform=null leaves release.platform untouched (fabrication guard holds)", async () => {
    const f = film({ tmdbId: 1, title: "Nazar", tier: "yellow", pillar: "ott", release: rel([]) });
    const results = [result([f], "ott")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 1, verdict: "unverified", reason: "couldn't confirm via search", platform: null }] });
    await annotateWithAiReview(results);
    expect(f.release!.platform).toEqual([]);
    expect(f.aiReview?.platformFound).toBeUndefined();
  });

  it("a mappable platform + EMPTY release.platform → filled via toPlatform (enum, not raw text); no conflict recorded", async () => {
    const f = film({ tmdbId: 2, title: "Karakkam", tier: "yellow", pillar: "ott", release: rel([]) });
    const results = [result([f], "ott")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 2, verdict: "confirm", reason: "SonyLIV confirms", sourceUrl: "https://x.example", platform: "Sony LIV" }] });
    await annotateWithAiReview(results);
    expect(f.release!.platform).toEqual(["SonyLIV"]);
    expect(f.aiReview?.platformFound).toBe("Sony LIV");
    expect(f.aiReview?.platformAgrees).toBeUndefined();     // nothing to compare against (was empty)
  });

  it("a DIFFERENT platform on a NON-empty release.platform records platformAgrees=false, but annotate does NOT override", async () => {
    const f = film({ tmdbId: 3, title: "Mollywood Times", tier: "green", pillar: "ott", release: rel(["ZEE5"]) });
    const results = [result([f], "ott")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 3, verdict: "confirm", reason: "SonyLIV per press", sourceUrl: "https://x.example", platform: "SonyLIV" }] });
    await annotateWithAiReview(results);
    expect(f.release!.platform).toEqual(["ZEE5"]);          // unchanged — annotate never suppresses (enforce does)
    expect(f.aiReview?.platformAgrees).toBe(false);         // conflict recorded
  });

  it("BLAST-RADIUS GUARD: the theatrical edition is NOT filled (OTT-only gate)", async () => {
    const f = film({ tmdbId: 4, title: "Alpha", tier: "yellow", pillar: "theatrical", release: rel([]) });
    const results = [result([f], "theatrical")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 4, verdict: "confirm", reason: "future OTT mentioned", sourceUrl: "https://x.example", platform: "Netflix" }] });
    await annotateWithAiReview(results);
    expect(f.release!.platform).toEqual([]);                // theatrical card stays empty
  });
});

describe("classifyDomainTrust — code-owned source-domain tiers", () => {
  it("denylist: exact host, mirror stem, and www prefix all resolve to deny", () => {
    expect(classifyDomainTrust("https://mlsbd.tv/movie")).toBe("deny");
    expect(classifyDomainTrust("https://www.mlsbd.shop/x")).toBe("deny");     // mirror stem
    expect(classifyDomainTrust("https://tamilrockers.wtf/x")).toBe("deny");
  });
  it("allowlist trade press → allow; unknown outlet → unknown; non-URL → unknown", () => {
    expect(classifyDomainTrust("https://www.pinkvilla.com/a")).toBe("allow");
    expect(classifyDomainTrust("https://123telugu.com/a")).toBe("allow");
    expect(classifyDomainTrust("https://some-random-blog.example/a")).toBe("unknown");
    expect(classifyDomainTrust(undefined)).toBe("unknown");
    expect(classifyDomainTrust("not a url")).toBe("unknown");
  });
});

describe("buildReviewPrompt — date-recency instruction", () => {
  it("steers a CONFIRMED out-of-window negative to reject, while guarding against over-removing real films", () => {
    const prompt = buildReviewPrompt(
      "theatrical",
      "2026-06-24 → 2026-06-28",
      [film({ tmdbId: 1, title: "Lenin", tier: "yellow", date: "2026-06-26" })]
    );
    expect(prompt).toContain("2026-06-24 → 2026-06-28");
    expect(prompt).toContain("RECENT + AUTHORITATIVE");
    expect(prompt).toContain("A recent RUMOR does NOT override an older OFFICIAL confirmation");
    expect(prompt).toContain("does NOT disqualify a later OTT or wider release");
    expect(prompt).toContain("delayed indefinitely");
    expect(prompt).toContain('When unsure, prefer "doubt"');
  });
});
