// auto-demote.test.ts — the ENFORCEMENT spine (Phase 2 + 3), end-to-end.
// annotateWithAiReview (LLM + cache mocked) → REAL enforceVerification → REAL
// decideGate / computeDropHash / writeReview. Enforcement now ACTS on the
// annotated verdicts: a contradicted/unconfirmed film (or an OTT film with no
// confirmed platform) is REMOVED from renderable and moves the gate hash; a
// search-corroborated single-net 🟡 is PROMOTED to effective-🟢; a conflicting
// platform is SUPPRESSED. decideGate AUTO-PUBLISHES a fully verification-clean
// drop and BLOCKS anything ambiguous. Offline. Run: npx vitest run --dir src/reconcile
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
import { annotateWithAiReview, enforceVerification, type EnforceOptions } from "../ai-review.js";
import { decideGate, computeDropHash, writeReview, WED_DROP_LABELS } from "../gate.js";
import type { Release } from "../../shared/types.js";
import type { ReconcileResult, ReconciledFilm } from "../types.js";

const mockCall = vi.mocked(callClaudeJSON);

function release(id: string, tmdbId: number, platform: string[] = ["Netflix"]): Release {
  return {
    id, tmdbId, title: `Film ${tmdbId}`, language: "Tamil", isSeries: false, platform: platform as Release["platform"],
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

/** annotate (mocked LLM) then run the REAL enforcement pass. */
async function annotateAndEnforce(results: ReconcileResult[], opts: EnforceOptions = { requireOttPlatform: true }): Promise<void> {
  await annotateWithAiReview(results);
  enforceVerification(results, opts);
}
const renderIds = (d: ReturnType<typeof decideGate>, pillar = "theatrical") => (d.renderable[pillar] ?? []).map((r) => r.id);

beforeEach(() => {
  mockCall.mockReset();
  cacheMock.store.clear();
  notionMock.createArgs = undefined;
  notionMock.appendCalls = [];
  vi.mocked(ofetch).mockClear();
});

describe("enforceVerification — demotion classes (contradicted + unconfirmed + denylist)", () => {
  it("HEADLINE: a sourced reject (contradicted) is REMOVED, the hash MOVES, remainder AUTO-publishes", async () => {
    const films = [film({ tmdbId: 11, title: "Good Film" }), film({ tmdbId: 12, title: "Sardar 2" })];
    const results = [result(films)];
    const preHash = computeDropHash(results);
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 11, verdict: "confirm", reason: "confirmed", sourceUrl: "https://variety.com/good" },
        { tmdbId: 12, verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://www.thehindu.com/sardar" },
      ],
    });
    await annotateAndEnforce(results);

    expect(films[1]!.aiDemoted?.demotionClass).toBe("contradicted");
    expect(computeDropHash(results)).not.toBe(preHash);          // hash moved — approval binds to the demoted set

    const decision = decideGate(results, {});                   // remainder (Good Film) is all effective-🟢 → AUTO
    expect(decision.mode).toBe("auto");
    expect(decision.proceed).toBe(true);
    expect(renderIds(decision)).toEqual(["r11"]);               // demoted film not renderable
  });

  it("NEW: an unconfirmed doubt AND an unverified are BOTH demoted (verification is enforcing now)", async () => {
    const films = [
      film({ tmdbId: 1, title: "Confirm" }),
      film({ tmdbId: 2, title: "Doubt", tier: "yellow", foundIn: ["tmdb", "ai-net"] }),
      film({ tmdbId: 3, title: "Unverified", tier: "yellow", foundIn: ["tmdb", "ai-net"] }),
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/1" },
        { tmdbId: 2, verdict: "doubt", reason: "contested date", sourceUrl: "https://news.example/2" },
        { tmdbId: 3, verdict: "unverified", reason: "couldn't confirm via search" },
      ],
    });
    await annotateAndEnforce(results);
    expect(films[1]!.aiDemoted?.demotionClass).toBe("unconfirmed");
    expect(films[2]!.aiDemoted?.demotionClass).toBe("unconfirmed");
    // Only the confirmed film survives → still auto (remainder is clean).
    const d = decideGate(results, {});
    expect(renderIds(d)).toEqual(["r1"]);
  });

  it("a piracy-only 'confirm' (denylisted source) is demoted as unconfirmed — code overrides LLM optimism", async () => {
    const films = [film({ tmdbId: 5, title: "Piracy-sourced" })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 5, verdict: "confirm", reason: "date per aggregator", sourceUrl: "https://mlsbd.tv/x" }] });
    await annotateAndEnforce(results);
    expect(films[0]!.aiReview?.trust).toBe("unconfirmed");
    expect(films[0]!.aiDemoted?.demotionClass).toBe("unconfirmed");
    expect(renderIds(decideGate(results, { approveHash: computeDropHash(results) }))).toEqual([]);
  });

  it("an infra failure (⚠️ unavailable) demotes NOTHING and FORCES the manual gate (infra ≠ verdict)", async () => {
    const films = [film({ tmdbId: 7, title: "X" }), film({ tmdbId: 8, title: "Y" })];
    const results = [result(films)];
    mockCall.mockRejectedValue(new Error("CLI exploded"));
    await annotateAndEnforce(results);
    expect(films.every((f) => f.aiReview?.verdict === "unavailable")).toBe(true);
    expect(films.every((f) => f.aiDemoted === undefined)).toBe(true);   // nothing demoted
    const d = decideGate(results, {});
    expect(d.mode).toBe("blocked");                                     // uncertainty forces the gate
    const approved = decideGate(results, { approveHash: d.hash });
    expect(renderIds(approved)).toEqual(expect.arrayContaining(["r7", "r8"]));  // --approve still renders both
  });
});

describe("enforceVerification — promotion (single-net 🟡 corroborated by search)", () => {
  it("promotes a single-net-ONLY 🟡 with a non-denylisted confirm → effective-🟢 → AUTO-publishes", async () => {
    const films = [film({ tmdbId: 21, title: "AI-only find", tier: "yellow", foundIn: ["ai-net"], reasons: ["single-net"] })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 21, verdict: "confirm", reason: "press confirms", sourceUrl: "https://www.pinkvilla.com/x" }] });
    await annotateAndEnforce(results);
    expect(films[0]!.aiPromoted).toBeDefined();
    expect(films[0]!.aiDemoted).toBeUndefined();
    const d = decideGate(results, {});
    expect(d.mode).toBe("auto");                                       // promoted 🟡 counts as effective-🟢
    expect(renderIds(d)).toEqual(["r21"]);
  });

  it("REFINEMENT 1: a 🟡 with single-net PLUS ambiguous-match is NOT promoted by a mere confirm → blocks the gate", async () => {
    const films = [film({ tmdbId: 22, title: "Ambiguous", tier: "yellow", foundIn: ["ai-net"], ambiguousMatch: true, reasons: ["single-net", "ambiguous TMDb match"] })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 22, verdict: "confirm", reason: "press confirms", sourceUrl: "https://www.pinkvilla.com/x" }] });
    await annotateAndEnforce(results);
    expect(films[0]!.aiPromoted).toBeUndefined();                      // a real data problem still needs the human
    expect(films[0]!.aiDemoted).toBeUndefined();                      // confirmed → not demoted either
    const d = decideGate(results, {});
    expect(d.mode).toBe("blocked");                                    // plain 🟡 left → manual gate
    expect(renderIds(decideGate(results, { approveHash: d.hash }))).toEqual(["r22"]);  // renders on --approve
  });
});

describe("enforceVerification — platform conflict + OTT-require (Decision 2)", () => {
  it("OTT platform conflict → suppress → REQUIRE_PLATFORM demotes with a TRUTHFUL 'platform conflict' reason", async () => {
    const f = film({ tmdbId: 31, title: "SonyLIV vs ZEE5", pillar: "ott", release: release("r31", 31, ["ZEE5"]) });
    const results = [result([f], "ott")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 31, verdict: "confirm", reason: "SonyLIV per press", sourceUrl: "https://variety.com/x", platform: "SonyLIV" }] });
    await annotateAndEnforce(results, { requireOttPlatform: true });
    expect(f.platformSuppressed).toEqual({ was: "ZEE5", pressPlatform: "SonyLIV" });
    expect(f.release!.platform).toEqual([]);                          // suppressed, never auto-substituted
    expect(f.aiDemoted?.demotionClass).toBe("platform-conflict");
    expect(f.aiDemoted?.reason).toContain("JustWatch: ZEE5");
    expect(f.aiDemoted?.reason).toContain("press: SonyLIV");
  });

  it("THEATRICAL platform conflict → suppression ONLY, film still renderable (no OTT requirement)", async () => {
    const f = film({ tmdbId: 32, title: "Theatrical conflict", pillar: "theatrical", release: release("r32", 32, ["ZEE5"]) });
    const results = [result([f], "theatrical")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 32, verdict: "confirm", reason: "SonyLIV per press", sourceUrl: "https://variety.com/x", platform: "SonyLIV" }] });
    await annotateAndEnforce(results, { requireOttPlatform: true });
    expect(f.platformSuppressed).toBeDefined();
    expect(f.release!.platform).toEqual([]);
    expect(f.aiDemoted).toBeUndefined();                              // theatrical is exempt from the platform requirement
    expect(renderIds(decideGate(results, {}))).toEqual(["r32"]);
  });

  it("OTT film with NO platform after all nets → demoted 'no-platform' when the dial is ON; kept when OFF", async () => {
    const mk = () => [result([film({ tmdbId: 33, title: "No platform", pillar: "ott", release: release("r33", 33, []) })], "ott")];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 33, verdict: "confirm", reason: "date confirmed", sourceUrl: "https://variety.com/x", platform: null }] });

    const on = mk();
    await annotateAndEnforce(on, { requireOttPlatform: true });
    expect(on[0]!.reconciled[0]!.aiDemoted?.demotionClass).toBe("no-platform");

    mockCall.mockClear();
    const off = mk();
    await annotateAndEnforce(off, { requireOttPlatform: false });
    expect(off[0]!.reconciled[0]!.aiDemoted).toBeUndefined();          // dial off → kept
  });
});

describe("decideGate — auto-publish predicate (Phase 3)", () => {
  it("ALL effective-🟢 across BOTH editions → auto-publish, proceed, no --approve needed", async () => {
    const results = [
      result([film({ tmdbId: 1, title: "T" })], "theatrical"),
      result([film({ tmdbId: 2, title: "O", pillar: "ott" })], "ott"),
    ];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/1" },
        { tmdbId: 2, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/2", platform: null },
      ],
    });
    await annotateAndEnforce(results);
    const d = decideGate(results, {});
    expect(d.mode).toBe("auto");
    expect(d.proceed).toBe(true);
  });

  it("EMPTY-EDITION GUARD: an edition wiped to 0 by enforcement BLOCKS auto even if the other is all-🟢", async () => {
    const results = [
      result([film({ tmdbId: 1, title: "Clean" })], "theatrical"),
      result([film({ tmdbId: 2, title: "Killed", pillar: "ott" })], "ott"),
    ];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/1" },
        { tmdbId: 2, verdict: "reject", reason: "cancelled", sourceUrl: "https://variety.com/2" },   // ott wiped to 0
      ],
    });
    await annotateAndEnforce(results);
    expect(decideGate(results, {}).mode).toBe("blocked");
  });

  it("KILL-SWITCH: alwaysGate=true blocks even an all-effective-🟢 drop", async () => {
    const results = [result([film({ tmdbId: 1, title: "Clean" })])];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/1" }] });
    await annotateAndEnforce(results);
    expect(decideGate(results, {}).mode).toBe("auto");                // default
    expect(decideGate(results, { alwaysGate: true }).mode).toBe("blocked");
  });

  it("a plain 🟡 (confirmed, multi-issue, not promoted) blocks auto and renders on --approve", async () => {
    const films = [film({ tmdbId: 1, title: "Dup", tier: "yellow", possibleDuplicate: true, reasons: ["possible-duplicate"] })];
    const results = [result(films)];
    mockCall.mockResolvedValue({ reviews: [{ tmdbId: 1, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/1" }] });
    await annotateAndEnforce(results);
    const d = decideGate(results, {});
    expect(d.mode).toBe("blocked");
    expect(renderIds(decideGate(results, { approveHash: d.hash }))).toEqual(["r1"]);
  });

  it("CACHE determinism: the --approve re-run reproduces the SAME hash + demotion with NO second LLM call", async () => {
    const mk = (): ReconcileResult[] => [result([film({ tmdbId: 31, title: "Postponed" }), film({ tmdbId: 32, title: "Good" })])];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 31, verdict: "reject", reason: "postponed to July", sourceUrl: "https://www.thehindu.com/p" },
        { tmdbId: 32, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/g" },
      ],
    });
    const reviewRun = mk();
    await annotateAndEnforce(reviewRun);
    const reviewHash = computeDropHash(reviewRun);
    expect(mockCall).toHaveBeenCalledTimes(1);

    const approveRun = mk();
    await annotateAndEnforce(approveRun);                              // cache HIT — no live call
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(computeDropHash(approveRun)).toBe(reviewHash);              // identical → approval matches what renders
    expect(renderIds(decideGate(approveRun, { approveHash: reviewHash }))).toEqual(["r32"]);
  });
});

describe("writeReview — enforcement audit surfaced (blocked path)", () => {
  it("shows the Auto-removed section (class + reason), the Promoted + Suppressed sections, and never double-lists", async () => {
    const films = [
      film({ tmdbId: 11, title: "Good Film" }),                                                   // confirm (green)
      film({ tmdbId: 12, title: "Sardar 2", tier: "yellow", foundIn: ["tmdb", "ai-net"] }),       // reject → auto-removed
      film({ tmdbId: 13, title: "Promoted Find", tier: "yellow", foundIn: ["ai-net"], reasons: ["single-net"] }), // confirm → promoted
      film({ tmdbId: 14, title: "Conflicted", pillar: "theatrical", release: release("r14", 14, ["ZEE5"]) }),     // platform conflict → suppressed
    ];
    const results = [result(films)];
    mockCall.mockResolvedValue({
      reviews: [
        { tmdbId: 11, verdict: "confirm", reason: "ok", sourceUrl: "https://variety.com/good" },
        { tmdbId: 12, verdict: "reject", reason: "releases Sept 10, not this window", sourceUrl: "https://www.thehindu.com/sardar" },
        { tmdbId: 13, verdict: "confirm", reason: "press confirms", sourceUrl: "https://www.pinkvilla.com/x" },
        { tmdbId: 14, verdict: "confirm", reason: "SonyLIV per press", sourceUrl: "https://variety.com/x", platform: "SonyLIV" },
      ],
    });
    await annotateAndEnforce(results);
    // Force a block so writeReview runs (a promoted find is clean, but a suppressed
    // conflict leaves the drop non-uniform — assert via the review artifact anyway).
    await writeReview(results, computeDropHash(results), WED_DROP_LABELS);

    const childrenJson = JSON.stringify(notionMock.createArgs.children);
    expect(childrenJson).toContain("Auto-removed by AI-review (1)");
    expect(childrenJson).toContain("🟡→🛑 Sardar 2");
    expect(childrenJson).toContain("contradicted:");                   // demotion class in the line
    expect((childrenJson.match(/Sardar 2/g) ?? []).length).toBe(1);    // listed ONCE

    const slackBody = JSON.stringify(vi.mocked(ofetch).mock.calls[0]?.[1]);
    expect(slackBody).toContain("Auto-removed by AI-review");
    expect(slackBody).toContain("Promoted");
    expect(slackBody).toContain("Promoted Find");
    expect(slackBody).toContain("Platform suppressed");
    expect(slackBody).toContain("Conflicted");
  });
});
