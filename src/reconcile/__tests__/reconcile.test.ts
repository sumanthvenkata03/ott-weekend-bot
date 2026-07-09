// src/reconcile/__tests__/reconcile.test.ts
// OFFLINE regression suite for the reconciliation core + gate. TMDb access is
// injected as plain mock functions, so nothing here touches the network, the
// LLM, or .env. Run with: npx vitest run --dir src/reconcile
import { describe, it, expect, vi } from "vitest";
import { reconcile, type ReconcileDeps } from "../reconcile.js";
import { computeDropHash, decideGate } from "../gate.js";
import { capPoolForSelector, AI_FIND_CEILING, SELECTOR_POOL_TARGET } from "../select.js";
import type { ExtractedFilm, ReconcileResult } from "../types.js";
import type { Release } from "../../shared/types.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { TmdbTitleHit, TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";

// ── Fixtures ────────────────────────────────────────────────────────────────
function makeRelease(p: Partial<Release> & { tmdbId: number; title: string }): Release {
  return {
    id: `tmdb-${p.tmdbId}`,
    language: "Tamil",
    isSeries: false,
    platform: [],
    releaseDate: "2026-06-24",
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
  return { isSeries: false, sources: [{ url: `https://news.example/${encodeURIComponent(p.title)}` }], ...p };
}

const OTT_WIN: BucketWindow = { start: "2026-06-22", end: "2026-06-28", dateField: "ott", label: "Now Streaming" };
const THEA_WIN: BucketWindow = { start: "2026-06-22", end: "2026-06-28", dateField: "theatrical", label: "In Theaters" };

/** Build mock deps from a title → search-result map + a cast map. */
function deps(
  searchMap: Record<string, TmdbTitleSearch>,
  castMap: Record<number, string[]> = {}
): ReconcileDeps {
  return {
    searchTitle: async (title) => searchMap[title] ?? { movie: [], tv: [] },
    fetchCredits: async (id) => ({ leadCast: castMap[id] ?? [] }),
  };
}

function hit(p: Partial<TmdbTitleHit> & { id: number; title: string }): TmdbTitleHit {
  return { ...p };
}

// ── Acceptance: Blast ───────────────────────────────────────────────────────
describe("Blast — AI net adds an OTT film TMDb discovery missed", () => {
  it("resolves the 2026 movie (not the 2019 same-title), press-date passes, tier 🟡 single-net", async () => {
    const aiFilms = [ai({ title: "Blast", language: "Tamil", platform: "Netflix", date: "2026-06-25" })];
    const search: Record<string, TmdbTitleSearch> = {
      Blast: {
        movie: [
          hit({ id: 9001, title: "Blast", year: 2026, originalLanguage: "ta", posterPath: "/blast.jpg", releaseDate: "2026-06-25" }),
          hit({ id: 1234, title: "Blast", year: 2019, originalLanguage: "ml", posterPath: "/old.jpg", releaseDate: "2019-05-31" }),
        ],
        tv: [],
      },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms, window: OTT_WIN },
      deps(search, { 9001: ["Arjun Das", "Anjali"] })
    );
    expect(r.reconciled).toHaveLength(1);
    const f = r.reconciled[0]!;
    expect(f.tmdbId).toBe(9001);                 // NOT 1234 (the 2019 Malayalam Blast)
    expect(f.resolvedTitle).toBe("Blast");
    expect(f.year).toBe(2026);
    expect(f.cast).toEqual(["Arjun Das", "Anjali"]); // cast from TMDb, not the LLM
    expect(f.posterUrl).toContain("/blast.jpg");
    expect(f.foundIn).toEqual(["ai-net"]);
    expect(f.ottDateFromPress).toBe(true);
    expect(f.dateSource).toBe("press");
    expect(f.landingStatus).toBe("pass");
    expect(f.status).toBe("confirmed");
    expect(f.tier).toBe("yellow");
    expect(f.reasons).toContain("single-net");
    expect(r.counts.addedByAiNet).toBe(1);
  });
});

// ── Acceptance: series rejection ────────────────────────────────────────────
describe("Series are rejected, never emitted", () => {
  it("rejects Lingam (LLM isSeries) and Gram Chikitsalay (TMDb tv-only)", async () => {
    const aiFilms = [
      ai({ title: "Lingam", isSeries: true }),
      ai({ title: "Gram Chikitsalay", language: "Hindi" }),
    ];
    const search: Record<string, TmdbTitleSearch> = {
      "Gram Chikitsalay": { movie: [], tv: [hit({ id: 7, title: "Gram Chikitsalay", year: 2026 })] },
    };
    const r = await reconcile({ pillar: "ott", tmdbPool: [], aiFilms, window: OTT_WIN }, deps(search));
    expect(r.reconciled).toHaveLength(0);
    const titles = r.rejected.map((x) => x.title);
    expect(titles).toContain("Lingam");
    expect(titles).toContain("Gram Chikitsalay");
  });
});

// ── Acceptance: Raja Shivaji date conflict ──────────────────────────────────
describe("Raja Shivaji — date conflict ⇒ 🟡, not auto-included", () => {
  it("flags conflicting dates and lands yellow (renderable only under manual approve)", async () => {
    const aiFilms = [
      ai({ title: "Raja Shivaji", language: "Marathi", date: "2026-06-26", datesSeen: ["2026-06-26", "2026-08-22"] }),
    ];
    const search: Record<string, TmdbTitleSearch> = {
      "Raja Shivaji": { movie: [hit({ id: 5000, title: "Raja Shivaji", year: 2026, originalLanguage: "mr" })], tv: [] },
    };
    const r = await reconcile({ pillar: "theatrical", tmdbPool: [], aiFilms, window: THEA_WIN }, deps(search, { 5000: ["Riteish"] }));
    const f = r.reconciled.find((x) => x.title === "Raja Shivaji")!;
    expect(f.conflictDetail).toBeTruthy();
    expect(f.tier).toBe("yellow");
    expect(f.reasons).toContain("date-conflict");
    expect(f.release).toBeDefined();             // exists, but yellow ⇒ never auto-passes
  });
});

// ── Acceptance: Kashmir 1947 manifest fail ──────────────────────────────────
describe("Kashmir 1947 — in pool, out of window, no AI corroboration ⇒ 🔴", () => {
  it("manifest fail pins it red and excludes it from render", async () => {
    const pool = [
      makeRelease({ tmdbId: 6000, title: "The Kashmir Files 1947", language: "Hindi", releaseDate: "2026-07-15", releaseDates: { theatrical: "2026-07-15" }, tmdbPopularity: 30 }),
    ];
    const r = await reconcile({ pillar: "theatrical", tmdbPool: pool, aiFilms: [], window: THEA_WIN }, deps({}));
    const f = r.reconciled[0]!;
    expect(f.landingStatus).toBe("fail");
    expect(f.tier).toBe("red");
    expect(f.foundIn).toEqual(["tmdb"]);
    // red ⇒ not renderable
    const decision = decideGate([r], { approveHash: computeDropHash([r]), autoPassGreen: false });
    expect((decision.renderable.theatrical ?? []).some((x) => x.tmdbId === 6000)).toBe(false);
  });
});

// ── Acceptance: unverified carries title + source ONLY ───────────────────────
describe("Unverified leads — title + source only, hard-pinned 🔴", () => {
  it("emits no fabricated date/platform/cast/poster and cannot render", async () => {
    const aiFilms = [ai({ title: "Totally Unknown Film", language: "Tamil", platform: "Netflix", date: "2026-06-25", confidence: "low" })];
    const r = await reconcile({ pillar: "ott", tmdbPool: [], aiFilms, window: OTT_WIN }, deps({}));
    const f = r.reconciled[0]!;
    expect(f.status).toBe("unverified");
    expect(f.tier).toBe("red");
    expect(f.release).toBeUndefined();
    expect(f.date).toBeUndefined();
    expect(f.platform).toBeUndefined();
    expect(f.cast).toBeUndefined();
    expect(f.posterUrl).toBeUndefined();
    expect(f.resolvedTitle).toBeUndefined();
    expect(f.language).toBe("Unknown");          // placeholder, NOT the LLM's claim
    expect(f.sourceUrl).toBeTruthy();
    expect(f.title).toBe("Totally Unknown Film");
  });
});

// ── Possible duplicate flagging (never merges) ──────────────────────────────
describe("Possible duplicates are flagged, never merged", () => {
  it("two distinct ids sharing a normalized title both get flagged 🟡", async () => {
    const pool = [makeRelease({ tmdbId: 200, title: "Identity", language: "Tamil", releaseDates: { ott: "2026-06-24" }, platform: ["Netflix"], tmdbPopularity: 10 })];
    const aiFilms = [ai({ title: "Identity (2026 film)", language: "Tamil", platform: "Netflix", date: "2026-06-24" })];
    const search: Record<string, TmdbTitleSearch> = {
      "Identity (2026 film)": { movie: [hit({ id: 999, title: "Identity", year: 2026, originalLanguage: "ta" })], tv: [] },
    };
    const r = await reconcile({ pillar: "ott", tmdbPool: pool, aiFilms, window: OTT_WIN }, deps(search, { 999: ["X"] }));
    // pool id 200 + new ai id 999 normalize to "identity" ⇒ both flagged
    expect(r.reconciled.every((f) => f.possibleDuplicate)).toBe(true);
    expect(r.reconciled.every((f) => f.tier === "yellow")).toBe(true);
  });
});

// ── Indian-language guard (NEW ai-net films only) ───────────────────────────
describe("Indian-language guard — applies to NEW AI-net discoveries only", () => {
  it("rejects an AI-net film whose TMDb originalLanguage is non-Indian (en), not emitted as 🟡", async () => {
    const aiFilms = [ai({ title: "Avatar Fire", platform: "Prime Video", date: "2026-06-24" })];
    const search: Record<string, TmdbTitleSearch> = {
      "Avatar Fire": { movie: [hit({ id: 83533, title: "Avatar: Fire and Ash", year: 2025, originalLanguage: "en", posterPath: "/a.jpg" })], tv: [] },
    };
    const r = await reconcile({ pillar: "ott", tmdbPool: [], aiFilms, window: OTT_WIN }, deps(search, { 83533: ["Sam Worthington"] }));
    // Not emitted as a tiered film...
    expect(r.reconciled.some((f) => f.title === "Avatar Fire" || f.title === "Avatar: Fire and Ash")).toBe(false);
    // ...routed to rejected with the language + source for audit.
    const rej = r.rejected.find((x) => x.reason === "non-Indian-language");
    expect(rej).toBeDefined();
    expect(rej!.title).toBe("Avatar Fire");
    expect(rej!.originalLanguage).toBe("en");
    expect(rej!.sourceUrl).toBeTruthy();
  });

  it("still emits an AI-net film whose TMDb originalLanguage IS Indian (ta)", async () => {
    const aiFilms = [ai({ title: "Tamil Newbie", language: "Tamil", platform: "Netflix", date: "2026-06-25" })];
    const search: Record<string, TmdbTitleSearch> = {
      "Tamil Newbie": { movie: [hit({ id: 4242, title: "Tamil Newbie", year: 2026, originalLanguage: "ta", posterPath: "/t.jpg" })], tv: [] },
    };
    const r = await reconcile({ pillar: "ott", tmdbPool: [], aiFilms, window: OTT_WIN }, deps(search, { 4242: ["Lead A"] }));
    const f = r.reconciled.find((x) => x.tmdbId === 4242)!;
    expect(f).toBeDefined();
    expect(f.status).toBe("confirmed");
    expect(f.tier).toBe("yellow");               // single-net, but emitted
    expect(r.rejected.some((x) => x.reason === "non-Indian-language")).toBe(false);
  });

  it("REGRESSION LOCK: a pool film corroborated by an AI hit tagged non-Indian is NEVER dropped", async () => {
    // Pool film id 300; an AI lead resolves to that SAME id with a non-Indian
    // (en) original_language tag. foundIn includes "tmdb" ⇒ the guard must not
    // touch it.
    const pool = [makeRelease({ tmdbId: 300, title: "Dubbed Pool Film", language: "Other", releaseDates: { ott: "2026-06-24" }, platform: ["Netflix"], tmdbPopularity: 20 })];
    const aiFilms = [ai({ title: "Dubbed Pool Film", platform: "Netflix", date: "2026-06-24" })];
    const search: Record<string, TmdbTitleSearch> = {
      "Dubbed Pool Film": { movie: [hit({ id: 300, title: "Dubbed Pool Film", year: 2026, originalLanguage: "en" })], tv: [] },
    };
    const r = await reconcile({ pillar: "ott", tmdbPool: pool, aiFilms, window: OTT_WIN }, deps(search));
    const f = r.reconciled.find((x) => x.tmdbId === 300)!;
    expect(f).toBeDefined();                                 // survived
    expect(f.foundIn.sort()).toEqual(["ai-net", "tmdb"]);    // merged, not dropped
    expect(r.rejected.some((x) => x.reason === "non-Indian-language")).toBe(false);
  });
});

// ── Date-fail reason propagation ────────────────────────────────────────────
describe("Date-fail reason is the precise assessDates reason", () => {
  it("a confirmed film with no qualifying date reports 'no qualifying date', not 'outside window'", async () => {
    // Pool film with NO ott date, in the OTT edition ⇒ landing fail (no date).
    const pool = [makeRelease({ tmdbId: 400, title: "No Date Film", language: "Tamil", tmdbPopularity: 5 })];
    const r = await reconcile({ pillar: "ott", tmdbPool: pool, aiFilms: [], window: OTT_WIN }, deps({}));
    const f = r.reconciled[0]!;
    expect(f.tier).toBe("red");
    expect(f.landingStatus).toBe("fail");
    expect(f.reasons.some((x) => x.includes("no qualifying date"))).toBe(true);
    expect(f.reasons.some((x) => x.includes("outside window"))).toBe(false);
  });

  it("an out-of-window film reports the date(s) + window, not the generic phrase", async () => {
    const pool = [makeRelease({ tmdbId: 401, title: "Old Film", language: "Hindi", releaseDates: { theatrical: "2026-05-01" }, tmdbPopularity: 5 })];
    const r = await reconcile({ pillar: "theatrical", tmdbPool: pool, aiFilms: [], window: THEA_WIN }, deps({}));
    const f = r.reconciled[0]!;
    expect(f.tier).toBe("red");
    expect(f.reasons.some((x) => x.includes("2026-05-01") && x.includes("outside window"))).toBe(true);
  });
});

// ── Pre-cap exemption (capPoolForSelector) ──────────────────────────────────
describe("capPoolForSelector — AI finds reach the LLM selector in a >40 pool", () => {
  function poolFilm(id: number, pop: number): Release {
    return makeRelease({ tmdbId: id, title: `Pool ${id}`, tmdbPopularity: pop, sources: ["tmdb"] });
  }
  function aiRelease(id: number, pop?: number): Release {
    return makeRelease({
      tmdbId: id, title: `AI ${id}`, sources: ["ai-net", "tmdb-search"],
      ...(pop !== undefined ? { tmdbPopularity: pop } : {}),
    });
  }

  it("keeps ALL K ai-net finds in a >40 pool; slices the pool portion to 40-K (total ≤ 40)", () => {
    const pool = Array.from({ length: 45 }, (_, i) => poolFilm(1000 + i, i + 1)); // pop 1..45
    const aiFinds = [aiRelease(1), aiRelease(2, 0), aiRelease(3)];                // 3 finds
    const out = capPoolForSelector([...pool, ...aiFinds]);
    expect(out.filter((r) => r.sources.includes("ai-net"))).toHaveLength(3);     // all K survive
    expect(out.filter((r) => !r.sources.includes("ai-net"))).toHaveLength(37);   // 40 - K pool
    expect(out.length).toBe(40);
    for (const id of [1, 2, 3]) expect(out.some((r) => r.tmdbId === id)).toBe(true);
  });

  it("still cuts a low-popularity POOL film when the pool exceeds its slice", () => {
    const pool = Array.from({ length: 45 }, (_, i) => poolFilm(1000 + i, i + 1)); // pop 1..45
    const aiFinds = [aiRelease(1), aiRelease(2), aiRelease(3)];
    const out = capPoolForSelector([...pool, ...aiFinds]);
    expect(out.some((r) => r.tmdbId === 1000)).toBe(false); // pop 1 — cut
    expect(out.some((r) => r.tmdbId === 1044)).toBe(true);  // pop 45 — kept
  });

  it("pathological K>ceiling: keeps exactly 40 ai finds (top by popularity), evicts the pool, warns loudly", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const aiFinds = Array.from({ length: 41 }, (_, i) => aiRelease(2000 + i, i)); // pop 0..40
    const pool = [poolFilm(9000, 100), poolFilm(9001, 99)];
    const out = capPoolForSelector([...aiFinds, ...pool]);
    expect(out).toHaveLength(AI_FIND_CEILING);                       // exactly 40
    expect(out.every((r) => r.sources.includes("ai-net"))).toBe(true); // pool fully evicted
    expect(out.some((r) => r.tmdbId === 2000)).toBe(false);          // pop 0 ai find dropped
    expect(out.some((r) => r.tmdbId === 2040)).toBe(true);           // pop 40 kept
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("an ai-net find with undefined tmdbPopularity still survives (exempt regardless of popularity)", () => {
    const pool = Array.from({ length: 41 }, (_, i) => poolFilm(1000 + i, i + 1));
    const out = capPoolForSelector([...pool, aiRelease(7)]);          // ai 7 has no popularity
    expect(out.some((r) => r.tmdbId === 7)).toBe(true);
    expect(out.length).toBe(SELECTOR_POOL_TARGET);
  });

  it("a tmdb-only film is NOT treated as an AI find (still subject to the slice)", () => {
    const aiZero = aiRelease(7, 0);                                  // zero-pop AI find — exempt
    const tmdbZero = poolFilm(8000, 0);                             // zero-pop TMDb film — not exempt
    const pool = Array.from({ length: 40 }, (_, i) => poolFilm(1000 + i, i + 1)); // pop 1..40
    const out = capPoolForSelector([aiZero, tmdbZero, ...pool]);
    expect(out.some((r) => r.tmdbId === 7)).toBe(true);              // AI zero-pop survives
    expect(out.some((r) => r.tmdbId === 8000)).toBe(false);         // TMDb zero-pop cut
  });
});

// ── Gate: hash stability + approval binding + auto-pass ──────────────────────
describe("Gate — hash binding and auto-pass", () => {
  function greenResult(): Promise<ReconcileResult> {
    const pool = [makeRelease({ tmdbId: 100, title: "Green Film", language: "Tamil", releaseDates: { ott: "2026-06-24" }, platform: ["Netflix"], tmdbPopularity: 50 })];
    const aiFilms = [ai({ title: "Green Film", language: "Tamil", platform: "Netflix", date: "2026-06-24" })];
    const search: Record<string, TmdbTitleSearch> = {
      "Green Film": { movie: [hit({ id: 100, title: "Green Film", year: 2026, originalLanguage: "ta" })], tv: [] },
    };
    return reconcile({ pillar: "ott", tmdbPool: pool, aiFilms, window: OTT_WIN }, deps(search, { 100: ["A", "B"] }));
  }

  it("a both-net, in-window, conflict-free film is 🟢", async () => {
    const r = await greenResult();
    expect(r.reconciled[0]!.tier).toBe("green");
    expect(r.reconciled[0]!.foundIn.sort()).toEqual(["ai-net", "tmdb"]);
  });

  it("hash is deterministic; an all-🟢 drop auto-publishes; kill-switch + wrong-hash block; exact hash approves", async () => {
    const r = await greenResult();
    const h1 = computeDropHash([r]);
    expect(computeDropHash([r])).toBe(h1);                    // deterministic

    // Phase 3: an all-effective-🟢 drop with no uncertainty auto-publishes in the
    // same run — no manual approval needed.
    const auto = decideGate([r], {});
    expect(auto.proceed).toBe(true);
    expect(auto.mode).toBe("auto");
    expect((auto.renderable.ott ?? []).length).toBe(1);

    // WED_DROP_ALWAYS_GATE forces the manual gate: a wrong hash blocks, the exact
    // hash approves and renders the 🟢+🟡 set.
    expect(decideGate([r], { alwaysGate: true }).proceed).toBe(false);
    expect(decideGate([r], { alwaysGate: true, approveHash: "0000deadbeef" }).proceed).toBe(false);
    const approved = decideGate([r], { alwaysGate: true, approveHash: h1 });
    expect(approved.proceed).toBe(true);
    expect(approved.mode).toBe("approved");
    expect((approved.renderable.ott ?? []).length).toBe(1);
  });
});
