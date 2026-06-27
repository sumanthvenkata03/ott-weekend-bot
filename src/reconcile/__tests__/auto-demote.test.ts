// auto-demote.test.ts — Step 1 spine, end-to-end. A SOURCED 🛑 verdict auto-
// removes its film from the renderable pool, MOVES the gate hash so --approve
// binds to the demoted set, SURFACES the removal in the review, and is reproduced
// DETERMINISTICALLY by the verdict cache (the --approve re-run makes no second LLM
// call). Real annotateWithAiReview (LLM + cache mocked) → real decideGate /
// computeDropHash / writeReview. Offline. Run: npx vitest run --dir src/reconcile
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
// Stateful in-memory cache — same input ⇒ cache hit (no second LLM call). Mocking
// cache.js also keeps the suite off real SQLite.
const cacheMock = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("../../shared/cache.js", () => ({
  cached: async (key: string, loader: () => Promise<unknown>) => {
    if (cacheMock.store.has(key)) return cacheMock.store.get(key);
    const v = await loader();
    cacheMock.store.set(key, v);
    return v;
  },
}));
// Notion client (constructed at gate.js load) + Slack webhook captured for the
// "auto-removed" review-section assertions.
const notionMock = vi.hoisted(() => ({ createArgs: undefined as any, appendCalls: [] as any[] }));
vi.mock("@notionhq/client", () => ({
  Client: class {
    pages = { create: async (a: any) => { notionMock.createArgs = a; return { id: "p1", url: "https://notion.example/p1" }; } };
    blocks = { children: { append: async (a: any) => { notionMock.appendCalls.push(a); } } };
  },
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "x", NOTION_RELEASES_DB_ID: "db", SLACK_WEBHOOK_URL: "https://hooks.slack/test" },
}));

import { callClaudeJSON } from "../../content/claude.js";
import { ofetch } from "ofetch";
import { annotateWithAiReview } from "../ai-review.js";
import { decideGate, computeDropHash, writeReview, WED_DROP_LABELS } from "../gate.js";
import type { Release } from "../../shared/types.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";

const mockCall = vi.mocked(callClaudeJSON);

function release(id: string, tmdbId: number): Release {
  return {
    id, tmdbId, title: `Film ${tmdbId}`, language: "Tamil", isSeries: false, platform: ["Netflix"],
    releaseDate: "2026-06-25", genre: [], cast: [], synopsis: "", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-06-23T00:00:00.000Z",
  };
}
function film(p: Partial<ReconciledFilm> & { tmdbId: number; title: string }): ReconciledFilm {
  return {
    language: "Tamil", pillar: "theatrical", dateSource: "tmdb", date: "2026-06-26",
    foundIn: ["tmdb", "ai-net"], status: "confirmed", tier: "green", reasons: [],
    release: release(`r${p.tmdbId}`, p.tmdbId),
    ...p,
  } as ReconciledFilm;
}
function result(films: ReconciledFilm[], pillar = "theatrical"): ReconcileResult {
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
      flagged: films.filter((f) => f.tier !== "green").length,
    },
  };
}

beforeEach(() => {
  mockCall.mockReset();
  cacheMock.store.clear();
  notionMock.createArgs = undefined;
  notionMock.appendCalls = [];
  vi.mocked(ofetch).mockClear();
});

describe("auto-demote (Step 1) — 🛑 removes from renderable, moves the hash, stays consistent", () => {
  it("HEADLINE: Sardar 2 (sourced 🛑) is removed from renderable, the hash MOVES, and --approve <new-hash> proceeds", async () => {
    const films = [
      film({ tmdbId: 11, title: "Good Film" }),
      film({ tmdbId: 12, title: "Sardar 2" }),
    ];
    const results = [result(films)];
    const preHash = computeDropHash(results);

    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 11, verdict: "confirm", reason: "confirmed for this window", sourceUrl: "https://n/good" },
        { tmdbId: 12, verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://n/sardar" },
      ],
    });
    await annotateWithAiReview(results);

    // The hash MOVES — approval now binds to the demoted set.
    const postHash = computeDropHash(results);
    expect(postHash).not.toBe(preHash);

    // --approve <postHash> proceeds; the demoted film is NOT renderable.
    const decision = decideGate(results, { approveHash: postHash, autoPassGreen: false });
    expect(decision.proceed).toBe(true);
    expect(decision.mode).toBe("approved");
    const ids = (decision.renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).toContain("r11");
    expect(ids).not.toContain("r12");

    // The stale pre-demotion hash no longer approves (the list changed).
    expect(decideGate(results, { approveHash: preHash, autoPassGreen: false }).proceed).toBe(false);
  });

  it("the review SHOWS an 'Auto-removed' section, lists the film ONCE, and never double-lists it under 'verify these'", async () => {
    const films = [
      film({ tmdbId: 11, title: "Good Film" }),                    // confirm
      film({ tmdbId: 12, title: "Sardar 2", tier: "yellow" }),     // sourced reject → auto-removed
      film({ tmdbId: 13, title: "Contested Film", tier: "yellow" }), // doubt → keeps "verify these" alive
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 11, verdict: "confirm", reason: "ok", sourceUrl: "https://n/good" },
        { tmdbId: 12, verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://n/sardar" },
        { tmdbId: 13, verdict: "doubt", reason: "one source contests the date", sourceUrl: "https://n/contested" },
      ],
    });
    await annotateWithAiReview(results);
    await writeReview(results, computeDropHash(results), WED_DROP_LABELS);

    const childrenJson = JSON.stringify(notionMock.createArgs.children);
    expect(childrenJson).toContain("Auto-removed by AI-review (1)");
    expect(childrenJson).toContain("🟡→🛑 Sardar 2");
    expect(childrenJson).toContain("releases Sept 10, not this window");
    expect(childrenJson).toContain("https://n/sardar");
    // Listed ONCE (auto-removed section only) — NOT double-listed under its 🟡 tier.
    expect((childrenJson.match(/Sardar 2/g) ?? []).length).toBe(1);

    const slackBody = JSON.stringify(vi.mocked(ofetch).mock.calls[0]?.[1]);
    expect(slackBody).toContain("Auto-removed by AI-review");
    expect(slackBody).toContain("Sardar 2");
    // The "verify these" list exists (the doubt film) but must EXCLUDE the demoted
    // film — it's decided, not pending review.
    expect(slackBody).toContain("verify these");
    const verifyIdx = slackBody.indexOf("verify these");
    const verifySection = slackBody.slice(verifyIdx, slackBody.indexOf("Approve", verifyIdx));
    expect(verifySection).toContain("Contested Film");
    expect(verifySection).not.toContain("Sardar 2");
  });

  it("only 🛑 removes: ✅ confirm / ⚠️ doubt / ❓ unverified all stay renderable", async () => {
    const films = [
      film({ tmdbId: 1, title: "Confirm" }),
      film({ tmdbId: 2, title: "Doubt", tier: "yellow" }),
      film({ tmdbId: 3, title: "Unverified", tier: "yellow" }),
      film({ tmdbId: 4, title: "Reject" }),
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://n/1" },
        { tmdbId: 2, verdict: "doubt", reason: "contested", sourceUrl: "https://n/2" },
        { tmdbId: 3, verdict: "unverified", reason: "couldn't confirm via search" },
        { tmdbId: 4, verdict: "reject", reason: "cancelled", sourceUrl: "https://n/4" },
      ],
    });
    await annotateWithAiReview(results);
    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["r1", "r2", "r3"]));
    expect(ids).not.toContain("r4");
  });

  it("a failed AI-review (⚠️ unavailable) demotes NOTHING — films stay renderable (infra failure ≠ verdict)", async () => {
    const films = [film({ tmdbId: 7, title: "X" }), film({ tmdbId: 8, title: "Y", tier: "yellow" })];
    const results = [result(films)];
    mockCall.mockRejectedValue(new Error("CLI exploded"));
    await annotateWithAiReview(results);
    expect(films.every((f) => f.aiReview?.verdict === "unavailable")).toBe(true);
    expect(films.every((f) => f.aiDemoted === undefined)).toBe(true);
    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["r7", "r8"]));
  });

  it("autoPassGreen: a demoted 🟢 forces the manual gate (auto-pass cannot fire)", async () => {
    const films = [film({ tmdbId: 21, title: "A" }), film({ tmdbId: 22, title: "B" })];
    const results = [result(films)];

    // No demotion yet → an all-🟢 drop auto-passes.
    expect(decideGate(results, { autoPassGreen: true }).mode).toBe("auto");

    // Demote one (sourced 🛑) → auto-pass must NOT fire → blocked.
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 21, verdict: "confirm", reason: "ok", sourceUrl: "https://n/a" },
        { tmdbId: 22, verdict: "reject", reason: "cancelled", sourceUrl: "https://n/b" },
      ],
    });
    await annotateWithAiReview(results);
    const d = decideGate(results, { autoPassGreen: true });
    expect(d.proceed).toBe(false);
    expect(d.mode).toBe("blocked");
  });

  it("CACHE determinism: the --approve re-run reproduces the SAME hash with NO second LLM call", async () => {
    const mk = (): ReconcileResult[] => [result([film({ tmdbId: 31, title: "Postponed" }), film({ tmdbId: 32, title: "Good" })])];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 31, verdict: "reject", reason: "postponed to July", sourceUrl: "https://n/p" },
        { tmdbId: 32, verdict: "confirm", reason: "ok", sourceUrl: "https://n/g" },
      ],
    });

    const reviewRun = mk();
    await annotateWithAiReview(reviewRun);
    const reviewHash = computeDropHash(reviewRun);
    expect(mockCall).toHaveBeenCalledTimes(1);

    // The operator approves reviewHash; the job re-runs with --approve reviewHash.
    const approveRun = mk();
    await annotateWithAiReview(approveRun);                   // cache HIT — no live call
    expect(mockCall).toHaveBeenCalledTimes(1);
    const approveHash = computeDropHash(approveRun);
    expect(approveHash).toBe(reviewHash);                     // identical → approval matches what renders

    const decision = decideGate(approveRun, { approveHash, autoPassGreen: false });
    expect(decision.proceed).toBe(true);
    const ids = (decision.renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).not.toContain("r31");                         // demotion reproduced deterministically
    expect(ids).toContain("r32");
  });
});

// Step 2 — date-recency: GIVEN a recency-based search result, the verdict is a
// SOURCED reject and Step 1's spine auto-removes the film (B→A end-to-end). These
// assert the PLUMBING (recency reasoning → reject → demote); the recency JUDGMENT
// itself is the live LLM's (mocked here) and is validated on a real Wed Drop run.
describe("date-recency (Step 2) — a recent contradiction → 🛑 → auto-removed", () => {
  it("LENIN: a recent 'postponed to July 10, outside window' → reject → auto-removed (not the loud June 26)", async () => {
    const films = [
      film({ tmdbId: 101, title: "Lenin", tier: "yellow" }),       // given date 2026-06-26
      film({ tmdbId: 102, title: "Solid Film" }),                  // stays in
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 101, verdict: "reject", reason: "postponed to July 10 per a recent trade report — outside the June 24–28 window (older June 26 announcements are stale)", sourceUrl: "https://trade.example/lenin-postponed" },
        { tmdbId: 102, verdict: "confirm", reason: "release confirmed for the window", sourceUrl: "https://n/solid" },
      ],
    });
    await annotateWithAiReview(results);

    expect(films[0]!.aiReview?.verdict).toBe("reject");
    expect(films[0]!.aiDemoted?.sourceUrl).toBe("https://trade.example/lenin-postponed");

    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).not.toContain("r101");                            // auto-removed
    expect(ids).toContain("r102");

    await writeReview(results, computeDropHash(results), WED_DROP_LABELS);
    expect(JSON.stringify(notionMock.createArgs.children)).toContain("🟡→🛑 Lenin");
  });

  it("ITLLU ARJUNA: a recent 'already released on the same platform earlier' → reject → auto-removed", async () => {
    const films = [film({ tmdbId: 201, title: "Itllu Arjuna" })];  // given date 2026-06-26
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 201, verdict: "reject", reason: "already released on this platform in March 2026 per a recent review — not a June arrival", sourceUrl: "https://n/itllu-released" },
      ],
    });
    await annotateWithAiReview(results);

    expect(films[0]!.aiReview?.verdict).toBe("reject");
    expect(films[0]!.aiDemoted).toBeDefined();
    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).not.toContain("r201");
  });

  it("STAGGERED RELEASE: an earlier THEATRICAL run does NOT remove a legit in-window OTT drop (confirm → stays)", async () => {
    // The prompt instructs: a prior theatrical/regional release must NOT reject a later
    // OTT arrival. Here the correct verdict is "confirm", so the film stays renderable —
    // this guards against ever wiring "already released anywhere" into auto-demote.
    const films = [film({ tmdbId: 401, title: "Theatrical-then-OTT", tier: "yellow", pillar: "ott" })];
    const results = [result(films, "ott")];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 401, verdict: "confirm", reason: "earlier theatrical run, but the OTT drop lands in this window", sourceUrl: "https://n/ott-drop" },
      ],
    });
    await annotateWithAiReview(results);

    expect(films[0]!.aiDemoted).toBeUndefined();
    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.ott ?? []).map((r) => r.id);
    expect(ids).toContain("r401");
  });

  it("DOUBT boundary: a contested-but-UNRESOLVED date → doubt → NOT auto-removed (recency doesn't over-trigger)", async () => {
    const films = [film({ tmdbId: 301, title: "Contested Date Film", tier: "yellow" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 301, verdict: "doubt", reason: "two outlets give different June dates; neither is clearly newer/authoritative", sourceUrl: "https://n/contested" },
      ],
    });
    await annotateWithAiReview(results);

    expect(films[0]!.aiReview?.verdict).toBe("doubt");
    expect(films[0]!.aiDemoted).toBeUndefined();                  // flag-only — the human still judges it
    const ids = (decideGate(results, { approveHash: computeDropHash(results), autoPassGreen: false }).renderable.theatrical ?? []).map((r) => r.id);
    expect(ids).toContain("r301");                                // still renderable
  });
});
