// WD-ENG-21 — AI-REVIEW MUST BE ABLE TO ASSESS A TMDb-LESS FILM.
//
// ── THE DEFECT (live in gate 7c07f9ce0a38) ─────────────────────────────────
// The response schema required `tmdbId: z.number()` per review row. A manual add
// has no tmdbId, so the projection dropped the key entirely and the output spec
// demanded `"tmdbId": <number>`. The model did the honest thing and returned
// null for reviews[6] and reviews[7] (Judaa, Brahmakamala); zod rejected the
// whole response; the retry "succeeded" by silently OMITTING both rows; the two
// films fell through to `"not returned by AI-review"` and enforcement removed
// them as `unconfirmed`.
//
// Every manual add would have died that way. WD-ENG-11's contract says AI-review
// MAY CONTRADICT a manual entry — but it could never ASSESS one, so the only
// reachable outcome was silent removal. FORCE could not rescue them either: it
// keys on TMDb ids.
//
// ── WHAT THESE PINS COVER ──────────────────────────────────────────────────
//   1. A null-tmdbId row validates and matches its film (by `ref`).
//   2. WD-ENG-11 guardrail A — a CONFIRMED manual add survives enforcement.
//   3. WD-ENG-11 guardrail B — a CONTRADICTED one is still auto-removed, with
//      the contradiction's own reason and source, not "not returned".
//   4. WD-ENG-11 guardrail C — corroboration NEVER promotes it past yellow, and
//      never lets it carry the drop into unattended auto-publish.
//   5. A genuinely missing row still yields the honest "not returned" removal.
//   6. Numeric-tmdbId behaviour is unchanged, including for a model that echoes
//      no `ref` at all.
//
// Hermetic: the LLM transport and the SQLite cache are mocked. No network, no
// Anthropic call, no billed retry.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
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
import {
  annotateWithAiReview,
  buildReviewPrompt,
  enforceVerification,
  reviewRef,
  reviewRefs,
  AiReviewSchema,
  AI_REVIEW_CACHE_VERSION,
} from "../ai-review.js";
import { decideGate } from "../gate.js";
import { buildManualFilm, type ManualEntry } from "../manual-adds.js";
import { assignTier } from "../reconcile.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);
const ENFORCE = { requireOttPlatform: false };

/** The real Aug-19 evidence entries, through the real builder. */
function manual(title: string, language = "Punjabi"): ReconciledFilm {
  const entry: ManualEntry = {
    title,
    language,
    date: "2026-08-21",
    dateField: "theatrical",
    audioLanguages: { original: language },
    sourceUrls: ["https://www.siasat.com/16-films-releasing-in-hyderabad-theatres-on-friday-august-21-3526508/"],
    evidenceBasis: "trade-press",
  };
  return buildManualFilm(entry, "theatrical", false);
}

/** A normal TMDb-backed film, green and auto-publish-eligible. */
function tmdbFilm(tmdbId: number, title: string, tier: "green" | "yellow" = "green"): ReconciledFilm {
  const release: Release = {
    id: `tmdb-${tmdbId}`, tmdbId, title, language: "Malayalam", isSeries: false,
    platform: [], releaseDate: "2026-08-20", releaseDates: { theatrical: "2026-08-20" },
    genre: [], cast: [], synopsis: "", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-18T00:00:00.000Z",
  };
  return {
    tmdbId, title, language: "Malayalam", pillar: "theatrical",
    date: "2026-08-20", dateSource: "tmdb",
    foundIn: ["tmdb", "ai-net"], status: "confirmed", landingStatus: "pass",
    tier, reasons: [], release,
  } as ReconciledFilm;
}

function result(films: ReconciledFilm[], pillar = "theatrical"): ReconcileResult {
  return {
    pillar,
    window: { start: "2026-08-19", end: "2026-08-23" },
    reconciled: films,
    rejected: [],
    counts: {
      total: films.length,
      green: films.filter((f) => f.tier === "green").length,
      yellow: films.filter((f) => f.tier === "yellow").length,
      red: films.filter((f) => f.tier === "red").length,
      addedByAiNet: 0, flagged: 0,
    },
  };
}

beforeEach(() => {
  mockCall.mockReset();
  cacheMock.store.clear();
});

// ════════════════════════════════════════════════════════════════════════════
// THE SCHEMA ITSELF. The tests below mock callClaudeJSON, which is exactly where
// zod runs — so these parse real payloads through the real object, or the
// validation that broke gate 7c07f9ce0a38 would go untested.
describe("PART 0 — 🔒 THE SCHEMA ACCEPTS THE PAYLOAD THAT BROKE THE GATE", () => {
  /** reviews[6] / reviews[7] verbatim from the 7c07f9ce0a38 failure. */
  const NULL_ID_ROWS = {
    reviews: [
      { ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.thehindu.com/k" },
      { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "trade press confirms Aug 21", sourceUrl: "https://www.indianexpress.com/judaa" },
      { ref: "manual-brahmakamala", tmdbId: null, verdict: "unverified", reason: "couldn't confirm via search" },
    ],
  };

  it("a null tmdbId parses — this EXACT shape used to fail zod and burn the retry", () => {
    const parsed = AiReviewSchema.safeParse(NULL_ID_ROWS);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reviews).toHaveLength(3);
    expect(parsed.success && parsed.data.reviews[1]!.tmdbId).toBeNull();
  });

  it("an OMITTED tmdbId parses too — absence and null are both honest answers", () => {
    const parsed = AiReviewSchema.safeParse({
      reviews: [{ ref: "manual-judaa", verdict: "confirm", reason: "ok" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("a numeric tmdbId with NO ref still parses — the pre-WD-ENG-21 shape is untouched", () => {
    const parsed = AiReviewSchema.safeParse({
      reviews: [{ tmdbId: 1036081, verdict: "confirm", reason: "ok", sourceUrl: "https://x.example/a", platform: null }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.reviews[0]!.tmdbId).toBe(1036081);
  });

  it("🔒 NO `.refine()` requiring an id — an unattributable row must DEGRADE, never fail the edition", () => {
    // Requiring one-of(ref, tmdbId) would re-create the original bug: a hard
    // schema failure that costs a billed retry and takes every OTHER film's
    // verdict down with it. It parses; matching then drops it honestly.
    expect(AiReviewSchema.safeParse({ reviews: [{ verdict: "confirm", reason: "no key" }] }).success).toBe(true);
  });

  it("the verdict enum is still closed — a made-up verdict is still rejected", () => {
    expect(AiReviewSchema.safeParse({ reviews: [{ tmdbId: 1, verdict: "probably", reason: "x" }] }).success).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 — a null-tmdbId row VALIDATES and matches its film", () => {
  it("the exact shape that failed in gate 7c07f9ce0a38 now parses and lands", async () => {
    const judaa = manual("Judaa");
    const brahma = manual("Brahmakamala", "Kannada");
    const results = [result([tmdbFilm(1036081, "Khalifa Part 1"), judaa, brahma])];

    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "Onam theatrical confirmed", sourceUrl: "https://www.thehindu.com/khalifa" },
        // ↓ the two rows zod used to reject outright
        { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "trade press confirms Aug 21", sourceUrl: "https://www.indianexpress.com/judaa" },
        { ref: "manual-brahmakamala", tmdbId: null, verdict: "confirm", reason: "listed for Aug 21", sourceUrl: "https://www.deccanchronicle.com/brahmakamala" },
      ],
    });

    await annotateWithAiReview(results);

    expect(judaa.aiReview?.verdict).toBe("confirm");
    expect(judaa.aiReview?.reason).toBe("trade press confirms Aug 21");
    expect(judaa.aiReview?.trust).toBe("confirmed");
    expect(brahma.aiReview?.verdict).toBe("confirm");
    // The old failure signature must be gone.
    expect(judaa.aiReview?.reason).not.toBe("not returned by AI-review");
    expect(brahma.aiReview?.reason).not.toBe("not returned by AI-review");
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("an OMITTED tmdbId key (not just null) also matches, via ref", async () => {
    const judaa = manual("Judaa");
    const results = [result([judaa])];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "manual-judaa", verdict: "doubt", reason: "date contested", sourceUrl: "https://news.example/j" }],
    });
    await annotateWithAiReview(results);
    expect(judaa.aiReview?.verdict).toBe("doubt");
  });

  it("🔒 the ref is the RELEASE ID — collision-safe where the exact title is not", () => {
    // This window really did carry a TMDb "Judaa" (1649723) alongside the
    // operator's Punjabi "Judaa". Same title, different films, different refs.
    const operatorJudaa = manual("Judaa");
    const tmdbJudaa = tmdbFilm(1649723, "Judaa");
    expect(operatorJudaa.title).toBe(tmdbJudaa.title);            // titles collide…
    expect(reviewRef(operatorJudaa)).toBe("manual-judaa");        // …refs do not
    expect(reviewRef(tmdbJudaa)).toBe("tmdb-1649723");
    expect(reviewRef(operatorJudaa)).not.toBe(reviewRef(tmdbJudaa));
  });

  it("🔒 two same-titled films get DISTINCT refs, and each keeps its OWN verdict", async () => {
    const operatorJudaa = manual("Judaa");
    const tmdbJudaa = tmdbFilm(1649723, "Judaa");
    const results = [result([tmdbJudaa, operatorJudaa])];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1649723", tmdbId: 1649723, verdict: "reject", reason: "US film, not this release", sourceUrl: "https://variety.com/j" },
        { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "Punjabi release confirmed Aug 21", sourceUrl: "https://www.indianexpress.com/judaa" },
      ],
    });
    await annotateWithAiReview(results);
    expect(tmdbJudaa.aiReview?.verdict).toBe("reject");
    expect(operatorJudaa.aiReview?.verdict).toBe("confirm");
  });

  it("identical release ids inside one batch still get addressable refs", () => {
    const a = manual("Judaa");
    const b = manual("Judaa");
    expect(reviewRefs([a, b])).toEqual(["manual-judaa", "manual-judaa#2"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — the prompt TELLS the reviewer that TMDb-less films exist", () => {
  const prompt = () => buildReviewPrompt("theatrical", "2026-08-19 → 2026-08-23", [
    tmdbFilm(1036081, "Khalifa Part 1"),
    manual("Judaa"),
  ]);

  it("names operator-added films and requires them to be assessed on web evidence", () => {
    const p = prompt();
    expect(p).toMatch(/OPERATOR-ADDED \/ TMDb-LESS FILMS/);
    expect(p).toMatch(/"tmdbId": null/);
    expect(p).toMatch(/is NOT a reason to doubt, reject, or omit a film/);
  });

  it("forbids the two things the model actually did — inventing an id and dropping the row", () => {
    const p = prompt();
    expect(p).toMatch(/Do NOT invent an id/);
    expect(p).toMatch(/do NOT drop the row because you have no id for it/);
    expect(p).toMatch(/NEVER omit a film/);
  });

  it("the projection states the absence explicitly instead of dropping the key", () => {
    // The old projection emitted no tmdbId key at all for a manual add, so the
    // model saw a film with no id while being told to key by `<number>`.
    const p = prompt();
    expect(p).toMatch(/"ref": "manual-judaa"/);
    expect(p).toMatch(/"ref": "tmdb-1036081"/);
    expect(p).toMatch(/"tmdbId": 1036081/);
    expect(p).toMatch(/"tmdbId": null/);
  });

  it("the cache version moved off v3 — prompt AND schema shape both changed", () => {
    expect(AI_REVIEW_CACHE_VERSION).not.toBe("v3");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — 🔒 THE WD-ENG-11 GUARDRAILS, ALL THREE", () => {
  it("A — a CONFIRMED manual add SURVIVES enforcement", async () => {
    const judaa = manual("Judaa");
    const results = [result([tmdbFilm(1036081, "Khalifa Part 1"), judaa])];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.thehindu.com/k" },
        { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "trade press confirms Aug 21", sourceUrl: "https://www.indianexpress.com/judaa" },
      ],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(judaa.aiDemoted).toBeUndefined();
    expect(judaa.tier).toBe("yellow");
  });

  it("B — a CONTRADICTED manual add is STILL auto-removed, with the contradiction's own reason", async () => {
    const judaa = manual("Judaa");
    const results = [result([judaa])];
    mockCall.mockResolvedValue({
      reviews: [{
        ref: "manual-judaa", tmdbId: null, verdict: "reject",
        reason: "postponed to October 2026 per the distributor",
        sourceUrl: "https://www.indianexpress.com/judaa-postponed",
      }],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(judaa.aiDemoted).toBeDefined();
    expect(judaa.aiDemoted!.demotionClass).toBe("contradicted");
    expect(judaa.aiDemoted!.reason).toBe("postponed to October 2026 per the distributor");
    expect(judaa.aiDemoted!.sourceUrl).toBe("https://www.indianexpress.com/judaa-postponed");
    // The whole point: the removal now names the CONTRADICTION, not the schema.
    expect(judaa.aiDemoted!.reason).not.toBe("not returned by AI-review");
  });

  it("C — CORROBORATION NEVER PROMOTES a manual add past yellow", async () => {
    const judaa = manual("Judaa");
    const results = [result([judaa])];
    mockCall.mockResolvedValue({
      reviews: [{
        ref: "manual-judaa", tmdbId: null, verdict: "confirm",
        reason: "trade press confirms Aug 21",
        sourceUrl: "https://www.indianexpress.com/judaa", // ALLOWLISTED — the strongest confirm available
      }],
    });
    await annotateWithAiReview(results);
    expect(judaa.aiReview?.trust).toBe("confirmed");
    expect(judaa.aiReview?.sourceDomainTrust).toBe("allow");

    enforceVerification(results, ENFORCE);
    expect(judaa.aiPromoted).toBeUndefined();     // ← the pin
    expect(judaa.tier).toBe("yellow");
    expect(assignTier(judaa).tier).toBe("yellow");
  });

  it("C — …and a confirmed manual add can NEVER carry the drop into unattended auto-publish", async () => {
    const judaa = manual("Judaa");
    const clean = tmdbFilm(1036081, "Khalifa Part 1");
    const results = [result([clean, judaa])];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.thehindu.com/k" },
        { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.indianexpress.com/judaa" },
      ],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    // isEffectiveGreen returns true on `!!aiPromoted` ALONE — without the manual
    // guard this drop would have auto-published an operator assertion unattended.
    const decision = decideGate(results, {});
    expect(decision.mode).toBe("blocked");
    expect(decision.proceed).toBe(false);
  });

  it("the SAME confirm on a non-manual single-net 🟡 still promotes — the guard is narrow", async () => {
    const solo = tmdbFilm(1748479, "Harrd Disk", "yellow");
    solo.foundIn = ["tmdb"];                       // single-net, no other yellow-driver
    solo.landingStatus = "pass";
    const results = [result([solo])];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "tmdb-1748479", tmdbId: 1748479, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.indianexpress.com/hd" }],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);
    expect(solo.aiPromoted).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 4 — a GENUINELY missing row is still honestly reported", () => {
  it("a film the model did not return keeps the 'not returned' removal", async () => {
    const judaa = manual("Judaa");
    const brahma = manual("Brahmakamala", "Kannada");
    const results = [result([judaa, brahma])];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "ok", sourceUrl: "https://www.indianexpress.com/j" }],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(judaa.aiDemoted).toBeUndefined();
    expect(brahma.aiReview?.reason).toBe("not returned by AI-review");
    expect(brahma.aiReview?.trust).toBe("unconfirmed");
    expect(brahma.aiDemoted!.demotionClass).toBe("unconfirmed");
  });

  it("a row carrying NEITHER ref NOR tmdbId matches nothing and never throws", async () => {
    const judaa = manual("Judaa");
    const results = [result([judaa])];
    mockCall.mockResolvedValue({
      reviews: [{ verdict: "confirm", reason: "unattributable row" }],
    });
    await annotateWithAiReview(results);
    expect(judaa.aiReview?.reason).toBe("not returned by AI-review");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 5 — 🔒 NUMERIC-tmdbId BEHAVIOUR IS UNCHANGED", () => {
  it("a model that echoes ONLY tmdbId (no ref) still matches — the fallback holds", async () => {
    const a = tmdbFilm(1036081, "Khalifa Part 1");
    const b = tmdbFilm(1748479, "Harrd Disk", "yellow");
    const results = [result([a, b])];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1036081, verdict: "confirm", reason: "confirmed", sourceUrl: "https://www.thehindu.com/k" },
        { tmdbId: 1748479, verdict: "reject", reason: "postponed", sourceUrl: "https://variety.com/hd" },
      ],
    });
    await annotateWithAiReview(results);
    enforceVerification(results, ENFORCE);

    expect(a.aiReview?.verdict).toBe("confirm");
    expect(a.aiReview?.trust).toBe("confirmed");
    expect(a.aiDemoted).toBeUndefined();
    expect(b.aiReview?.verdict).toBe("reject");
    expect(b.aiDemoted!.demotionClass).toBe("contradicted");
    expect(b.aiDemoted!.sourceUrl).toBe("https://variety.com/hd");
  });

  it("the discipline guard still fires: an unsourced reject becomes 'unverified (no source cited)'", async () => {
    const a = tmdbFilm(1036081, "Khalifa Part 1");
    const results = [result([a])];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "tmdb-1036081", tmdbId: 1036081, verdict: "reject", reason: "heard it moved" }],
    });
    await annotateWithAiReview(results);
    expect(a.aiReview?.verdict).toBe("unverified");
    expect(a.aiReview?.reason).toBe("heard it moved (no source cited)");
    expect(a.aiReview?.trust).toBe("unconfirmed");
  });

  it("the denylist still overrides an optimistic confirm", async () => {
    const a = tmdbFilm(1036081, "Khalifa Part 1");
    const results = [result([a])];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "found it", sourceUrl: "https://mlsbd.tv/khalifa" }],
    });
    await annotateWithAiReview(results);
    expect(a.aiReview?.sourceDomainTrust).toBe("deny");
    expect(a.aiReview?.trust).toBe("unconfirmed");
  });

  it("seam-#3 platform fill still lands on an OTT film from the row's own platform field", async () => {
    const a = tmdbFilm(1443136, "Chennai Love Story");
    a.release!.platform = [];
    const results = [result([a], "ott")];
    mockCall.mockResolvedValue({
      reviews: [{ ref: "tmdb-1443136", tmdbId: 1443136, verdict: "confirm", reason: "ok", sourceUrl: "https://www.thehindu.com/c", platform: "Netflix" }],
    });
    await annotateWithAiReview(results);
    expect(a.aiReview?.platformFound).toBe("Netflix");
    expect(a.release!.platform).toEqual(["Netflix"]);
  });

  it("ONE call per edition, and the re-run is a cache hit (the --approve determinism spine)", async () => {
    const films = [tmdbFilm(1036081, "Khalifa Part 1"), manual("Judaa")];
    mockCall.mockResolvedValue({
      reviews: [
        { ref: "tmdb-1036081", tmdbId: 1036081, verdict: "confirm", reason: "ok", sourceUrl: "https://www.thehindu.com/k" },
        { ref: "manual-judaa", tmdbId: null, verdict: "confirm", reason: "ok", sourceUrl: "https://www.indianexpress.com/j" },
      ],
    });
    await annotateWithAiReview([result(films)]);
    expect(mockCall).toHaveBeenCalledTimes(1);
    await annotateWithAiReview([result(films)]);
    expect(mockCall).toHaveBeenCalledTimes(1); // cache hit — no second billed call
  });
});
