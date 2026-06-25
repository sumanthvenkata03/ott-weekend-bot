// src/reconcile/__tests__/ai-review.test.ts
// OFFLINE tests for the advisory AI-review tier. The LLM transport is mocked, so
// these are deterministic and never touch the network/CLI. They lock the
// authority boundary: annotate changes no tier, never feeds the hash, and fails
// soft toward MORE caution. Run: npx vitest run --dir src/reconcile
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
import { annotateWithAiReview } from "../ai-review.js";
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

describe("annotateWithAiReview — advisory, hash-invariant, fail-soft", () => {
  it("attaches advisory verdicts by tmdbId, leaves tiers untouched, and does NOT change the hash (no demotion)", async () => {
    const films = [
      film({ tmdbId: 1, title: "Kashmir 1947", tier: "green" }),
      film({ tmdbId: 2, title: "Sardar 2", tier: "yellow" }),
      film({ tmdbId: 3, title: "Unverified Lead", tier: "red", status: "unverified", foundIn: ["ai-net"] }),
    ];
    const results = [result(films)];
    const before = computeDropHash(results);
    // Advisory-only verdicts (confirm/doubt) — neither demotes, so the hash must NOT move.
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "trade press confirms the date", sourceUrl: "https://news.example/kashmir" },
        { tmdbId: 2, verdict: "doubt", reason: "one source contests the date", sourceUrl: "https://news.example/sardar" },
      ],
    });

    await annotateWithAiReview(results);

    expect(computeDropHash(results)).toBe(before);          // hash unchanged — non-demoting verdicts stay OUTSIDE the hash
    expect(films[0]!.tier).toBe("green");                   // tier untouched (never overwritten)
    expect(films[0]!.aiReview).toEqual({ verdict: "confirm", reason: "trade press confirms the date", sourceUrl: "https://news.example/kashmir" });
    expect(films[1]!.aiReview?.verdict).toBe("doubt");
    expect(films[0]!.aiDemoted).toBeUndefined();            // confirm → not demoted
    expect(films[1]!.aiDemoted).toBeUndefined();            // doubt → flag-only, not demoted
    expect(films[2]!.aiReview).toBeUndefined();             // 🔴 is skipped (gate-excluded already)
    expect(mockCall).toHaveBeenCalledTimes(1);              // ONE batched call for the edition
  });

  it("sets aiDemoted on a SOURCED reject ONLY — keyed on the verdict, not the tier (Blast 🟡/✅ is safe)", async () => {
    const films = [
      film({ tmdbId: 1, title: "Sardar 2", tier: "green" }),       // sourced reject → demoted
      film({ tmdbId: 2, title: "Contested", tier: "yellow" }),     // doubt → keep
      film({ tmdbId: 3, title: "Blast", tier: "yellow" }),         // 🟡 tier but ✅ verdict → keep
      film({ tmdbId: 4, title: "Obscure", tier: "green" }),        // unverified → keep
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://news.example/sardar2" },
        { tmdbId: 2, verdict: "doubt", reason: "date contested", sourceUrl: "https://news.example/contested" },
        { tmdbId: 3, verdict: "confirm", reason: "platform confirms the drop", sourceUrl: "https://news.example/blast" },
        { tmdbId: 4, verdict: "unverified", reason: "couldn't confirm via search" },
      ],
    });

    await annotateWithAiReview(results);

    expect(films[0]!.aiDemoted).toEqual({ originalTier: "green", verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://news.example/sardar2" });
    expect(films[0]!.tier).toBe("green");                   // demotion preserves the original tier
    expect(films[1]!.aiDemoted).toBeUndefined();            // ⚠️ doubt → flag-only
    expect(films[2]!.aiDemoted).toBeUndefined();            // ✅ verdict on a 🟡 film → never demoted (Blast safety)
    expect(films[3]!.aiDemoted).toBeUndefined();            // ❓ unverified → keep
  });

  it("a sourceless reject → unverified, and is NOT demoted (no actionable bare claim)", async () => {
    const films = [film({ tmdbId: 5, title: "Sourceless Reject", tier: "green" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 5, verdict: "reject", reason: "seems off" }] });
    await annotateWithAiReview(results);
    expect(films[0]!.aiReview?.verdict).toBe("unverified");
    expect(films[0]!.aiDemoted).toBeUndefined();
  });

  it("CACHE determinism: a re-run with the same input HITS the cache — same demotion, NO second LLM call", async () => {
    const mk = (): ReconcileResult[] => [result([film({ tmdbId: 1, title: "Postponed", tier: "green" })])];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 1, verdict: "reject", reason: "postponed to July", sourceUrl: "https://news.example/postponed" }] });

    const first = mk();
    await annotateWithAiReview(first);
    expect(mockCall).toHaveBeenCalledTimes(1);                       // review run = one live call
    expect(first[0]!.reconciled[0]!.aiDemoted?.verdict).toBe("reject");

    // The --approve re-run: FRESH film objects, same identity + window → cache hit.
    const second = mk();
    await annotateWithAiReview(second);
    expect(mockCall).toHaveBeenCalledTimes(1);                       // STILL one — re-run read the cache
    expect(second[0]!.reconciled[0]!.aiDemoted?.verdict).toBe("reject"); // demotion reproduced deterministically
  });

  it("downgrades a doubt/reject with NO sourceUrl to unverified (no bare authoritative claim)", async () => {
    const films = [film({ tmdbId: 5, title: "Sourceless", tier: "green" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 5, verdict: "reject", reason: "seems off" }] });
    await annotateWithAiReview(results);
    expect(films[0]!.aiReview?.verdict).toBe("unverified");
    expect(films[0]!.aiReview?.sourceUrl).toBeUndefined();
  });

  it("fail-soft: a failed/garbled review call marks every reviewed film 'unavailable', never blank", async () => {
    const films = [film({ tmdbId: 7, title: "X", tier: "green" }), film({ tmdbId: 8, title: "Y", tier: "yellow" })];
    const results = [result(films)];
    // A garbled result (no `reviews`) makes the mapping throw inside reviewEdition's
    // try — the SAME catch that handles a real call rejection/timeout — so every
    // reviewed film fails soft to "unavailable". (The live rejection path is
    // exercised separately in the job-level verification.)
    mockCall.mockResolvedValue(undefined as unknown as { reviews: never[] });
    await annotateWithAiReview(results);
    expect(films.every((f) => f.aiReview?.verdict === "unavailable")).toBe(true);
    expect(films[0]!.aiReview?.reason).toMatch(/verify manually/);
  });

  it("a film the model omits is marked unverified, not silently blank", async () => {
    const films = [film({ tmdbId: 9, title: "Returned", tier: "green" }), film({ tmdbId: 10, title: "Omitted", tier: "green" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 9, verdict: "confirm", reason: "ok", sourceUrl: "https://x.example" }] });
    await annotateWithAiReview(results);
    expect(films[1]!.aiReview?.verdict).toBe("unverified");
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
