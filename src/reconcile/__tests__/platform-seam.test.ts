// WD-ENG-03 — SEAM #3: the platform confirmation that never crossed the field
// boundary.
//
// THE DEFECT, verbatim from this week's diagnostics: reconcile entries for
// Kattalan and Aakhri Sawal carried platform strings that AI-review confirmed IN
// WRITING — "Trade press confirms Kattalan … streams on ManoramaMAX from August
// 13, 2026" — but the confirmation never reached release.platform, the field the
// no-platform demotion checks and the card renders. Both verified films were
// demoted and needed WED_DROP_FORCE + WED_DROP_PLATFORM to publish.
//
// Every fixture below is verbatim from output/runs/wed-drop-2026-08-13-results.json.
import { describe, it, expect, beforeEach, vi } from "vitest";

// gate.ts constructs a Notion client at module load, so the full chain
// (seam → enforce → decideGate) needs the same preamble gate-shared.test.ts uses.
vi.mock("@notionhq/client", () => ({
  Client: class {
    pages = { create: async () => ({ id: "p1", url: "https://notion.example/p1" }) };
    blocks = { children: { append: async () => {} } };
  },
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "x", NOTION_RELEASES_DB_ID: "db", SLACK_WEBHOOK_URL: "" },
}));

import {
  fillConfirmedPlatforms,
  resolvePlatformFill,
  isSeamEligible,
  splitPlatformString,
} from "../platform-seam.js";
import { enforceVerification } from "../ai-review.js";
import { computeDropHash, decideGate } from "../gate.js";
import { PLATFORMS, asExactPlatform } from "../../shared/platform.js";
import type { ReconciledFilm, ReconcileResult } from "../types.js";
import type { Platform, Release } from "../../shared/types.js";

// ── Fixture builders ────────────────────────────────────────────────────────
function rel(p: Partial<Release> & { id: string; title: string }): Release {
  return {
    language: "Malayalam", isSeries: false, platform: [] as Platform[],
    releaseDate: "2026-08-14", releaseDates: { ott: "2026-08-14" },
    genre: ["Drama"], cast: [], synopsis: "x".repeat(120), subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-13T03:30:58.686Z",
    audioLanguages: { original: "Malayalam" },
    ...p,
  } as Release;
}

function film(p: {
  title: string; tmdbId: number; platform?: string; releasePlatform?: Platform[];
  verdict?: "confirm" | "doubt" | "reject" | "unverified" | "unavailable";
  trust?: "confirmed" | "contradicted" | "unconfirmed";
  tier?: "green" | "yellow" | "red"; withRelease?: boolean;
}): ReconciledFilm {
  const f: ReconciledFilm = {
    title: p.title, language: "Malayalam", pillar: "ott", tmdbId: p.tmdbId,
    date: "2026-08-14", dateSource: "tmdb", foundIn: ["tmdb", "ai-net"],
    status: "confirmed", tier: p.tier ?? "green", reasons: [],
    ...(p.platform !== undefined ? { platform: p.platform } : {}),
  } as ReconciledFilm;
  if (p.withRelease !== false) {
    f.release = rel({ id: `tmdb-${p.tmdbId}`, tmdbId: p.tmdbId, title: p.title, platform: p.releasePlatform ?? [] });
  }
  if (p.verdict) {
    f.aiReview = {
      verdict: p.verdict,
      reason: "…",
      ...(p.trust ?? (p.verdict === "confirm" ? "confirmed" : "unconfirmed")
        ? { trust: p.trust ?? (p.verdict === "confirm" ? ("confirmed" as const) : ("unconfirmed" as const)) }
        : {}),
      sourceDomainTrust: "allow",
    };
  }
  return f;
}

const ottResult = (films: ReconciledFilm[]): ReconcileResult => ({
  pillar: "ott",
  window: { start: "2026-08-10", end: "2026-08-16" },
  reconciled: films,
  rejected: [],
  counts: { total: films.length, green: 0, yellow: 0, red: 0, addedByAiNet: 0, flagged: 0 },
});

// ── The Aug-13 films, verbatim ──────────────────────────────────────────────
const kattalan = () => film({ title: "Kattalan", tmdbId: 1065834, platform: "ManoramaMAX", verdict: "confirm", tier: "yellow" });
const aakhri = () => film({ title: "Aakhri Sawal", tmdbId: 1600771, platform: "Lionsgate Play", verdict: "confirm", tier: "green" });
const aroopi = () => film({
  title: "Aroopi", tmdbId: 1616268,
  platform: "Prime Video, SimplySouth, Lionsgate Play",
  releasePlatform: ["Prime Video"],                      // ALREADY populated upstream
  verdict: "confirm", tier: "green",
});
const september21 = () => film({ title: "September 21", tmdbId: 1747494, verdict: "doubt", trust: "unconfirmed", tier: "yellow" });

const ENFORCE = { requireOttPlatform: true };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the union is available at runtime and matched EXACTLY", () => {
  it("PLATFORMS covers every member the seam may write", () => {
    expect(PLATFORMS).toContain("ManoramaMAX");
    expect(PLATFORMS).toContain("Lionsgate Play");
    expect(PLATFORMS).toContain("Prime Video");
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);   // no duplicates
  });

  it("exact spelling only — no coercion to a neighbouring brand", () => {
    expect(asExactPlatform("ManoramaMAX")).toBe("ManoramaMAX");
    expect(asExactPlatform("  Lionsgate Play  ")).toBe("Lionsgate Play");  // trimmed
    expect(asExactPlatform("SimplySouth")).toBeUndefined();
    expect(asExactPlatform("manoramamax")).toBeUndefined();                // case matters
    expect(asExactPlatform("Manorama Max")).toBeUndefined();
    expect(asExactPlatform("")).toBeUndefined();
    expect(asExactPlatform(undefined)).toBeUndefined();
  });

  it("splits comma lists, and nothing else — platform names contain spaces and '+'", () => {
    expect(splitPlatformString("Prime Video, SimplySouth, Lionsgate Play"))
      .toEqual(["Prime Video", "SimplySouth", "Lionsgate Play"]);
    expect(splitPlatformString("ManoramaMAX")).toEqual(["ManoramaMAX"]);
    expect(splitPlatformString("Apple TV+")).toEqual(["Apple TV+"]);
    expect(splitPlatformString(" , Netflix , , ")).toEqual(["Netflix"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("KATTALAN (1065834) — the headline regression", () => {
  it("fills ManoramaMAX, the no-platform demotion does NOT fire, and it reaches the renderable pool", () => {
    const results = [ottResult([kattalan()])];
    const f = results[0]!.reconciled[0]!;
    expect(f.release!.platform).toEqual([]);              // the defect, as it stood

    fillConfirmedPlatforms(results);
    expect(f.release!.platform).toEqual(["ManoramaMAX"]);

    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted).toBeUndefined();                  // NOT demoted

    // …and it is in the pool decideGate hands to the renderer — no WED_DROP_FORCE.
    const decision = decideGate(results, { alwaysGate: true, approveHash: computeDropHash(results) });
    expect(decision.renderable.ott?.map((r) => r.title)).toEqual(["Kattalan"]);
    expect(decision.renderable.ott?.[0]!.platform).toEqual(["ManoramaMAX"]);
  });

  it("WITHOUT the seam it is still demoted for no-platform — the defect, pinned", () => {
    const results = [ottResult([kattalan()])];
    enforceVerification(results, ENFORCE);               // seam skipped
    const f = results[0]!.reconciled[0]!;
    expect(f.aiDemoted?.demotionClass).toBe("no-platform");
    expect(decideGate(results, { alwaysGate: true, approveHash: computeDropHash(results) }).renderable.ott).toEqual([]);
  });
});

describe("AAKHRI SAWAL (1600771) — same shape", () => {
  it("fills Lionsgate Play, no demotion, renderable", () => {
    const results = [ottResult([aakhri()])];
    fillConfirmedPlatforms(results);
    const f = results[0]!.reconciled[0]!;
    expect(f.release!.platform).toEqual(["Lionsgate Play"]);
    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted).toBeUndefined();
    expect(decideGate(results, { alwaysGate: true, approveHash: computeDropHash(results) })
      .renderable.ott?.map((r) => r.title)).toEqual(["Aakhri Sawal"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PRECEDENCE — fill only when empty (item 2)", () => {
  it("AROOPI (1616268): already populated upstream → the seam does not touch it", () => {
    const results = [ottResult([aroopi()])];
    const f = results[0]!.reconciled[0]!;
    const before = [...f.release!.platform];

    const fills = fillConfirmedPlatforms(results);

    expect(f.release!.platform).toEqual(before);          // ["Prime Video"], untouched
    expect(f.release!.platform).toEqual(["Prime Video"]);
    expect(fills).toEqual([]);                            // no fill recorded at all
    expect(f.platformFilled).toBeUndefined();
    expect(isSeamEligible(f)).toBe(false);
    // Crucially it did NOT become the 2-platform list the string would imply.
    expect(f.release!.platform).not.toContain("Lionsgate Play");
  });

  it("a JustWatch/TMDb platform is never overwritten even when the string disagrees", () => {
    const f = film({ title: "X", tmdbId: 1, platform: "Netflix", releasePlatform: ["ZEE5"], verdict: "confirm" });
    fillConfirmedPlatforms([ottResult([f])]);
    expect(f.release!.platform).toEqual(["ZEE5"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("UNKNOWN TOKENS — skipped loudly, never coerced (item 3)", () => {
  it('"Prime Video, SimplySouth, Lionsgate Play" on an EMPTY-platform film → the two valid members', () => {
    const f = film({
      title: "Aroopi-empty", tmdbId: 1616268,
      platform: "Prime Video, SimplySouth, Lionsgate Play",
      verdict: "confirm",
    });
    const fill = resolvePlatformFill(f)!;
    expect(fill.platforms).toEqual(["Prime Video", "Lionsgate Play"]);
    expect(fill.skipped).toEqual(["SimplySouth"]);
  });

  it("the warn names the film AND the token", () => {
    const warn = vi.fn();
    const f = film({ title: "Aroopi-empty", tmdbId: 1616268, platform: "Prime Video, SimplySouth, Lionsgate Play", verdict: "confirm" });
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { warn(String(line)); });

    fillConfirmedPlatforms([ottResult([f])]);

    const all = warn.mock.calls.map((c) => c[0] as string).join("\n");
    expect(all).toContain("[platform-seam] Aroopi-empty: AI-review-confirmed → Prime Video, Lionsgate Play");
    expect(all).toContain("SimplySouth");
    expect(all).toContain("Aroopi-empty");
  });

  it("ZERO valid tokens → NO fill, and the demotion proceeds exactly as today", () => {
    const f = film({ title: "Ghost", tmdbId: 9, platform: "SimplySouth, Some Regional App", verdict: "confirm" });
    const results = [ottResult([f])];

    expect(resolvePlatformFill(f)).toBeNull();
    fillConfirmedPlatforms(results);
    expect(f.release!.platform).toEqual([]);
    expect(f.platformFilled).toBeUndefined();

    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted?.demotionClass).toBe("no-platform");   // unchanged behaviour
  });

  it("a repeated valid token yields ONE chip", () => {
    const f = film({ title: "Dup", tmdbId: 8, platform: "Netflix, Netflix", verdict: "confirm" });
    expect(resolvePlatformFill(f)!.platforms).toEqual(["Netflix"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("VERDICT GATING — only `confirm` fills", () => {
  it("SEPTEMBER 21 (1747494), as it really is: no platform string → byte-untouched", () => {
    const results = [ottResult([september21()])];
    const f = results[0]!.reconciled[0]!;
    const snapshot = JSON.stringify(f);

    fillConfirmedPlatforms(results);

    expect(JSON.stringify(f)).toBe(snapshot);
    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted).toBeDefined();                    // demotion fires as today
  });

  it("September-21 CLASS: platform string present but verdict unconfirmed → no fill", () => {
    const f = film({ title: "September 21", tmdbId: 1747494, platform: "ZEE5", verdict: "doubt", trust: "unconfirmed", tier: "yellow" });
    const results = [ottResult([f])];

    fillConfirmedPlatforms(results);
    expect(f.release!.platform).toEqual([]);
    expect(f.platformFilled).toBeUndefined();

    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted?.demotionClass).toBe("unconfirmed");
  });

  it.each([["doubt"], ["reject"], ["unverified"], ["unavailable"]] as const)(
    "verdict %s never fills",
    (verdict) => {
      const f = film({ title: "V", tmdbId: 2, platform: "Netflix", verdict });
      expect(resolvePlatformFill(f)).toBeNull();
    }
  );

  it("a film with NO aiReview at all never fills", () => {
    const f = film({ title: "NoReview", tmdbId: 3, platform: "Netflix" });
    expect(f.aiReview).toBeUndefined();
    expect(resolvePlatformFill(f)).toBeNull();
  });

  it("a film with no release record never fills (nothing to write into)", () => {
    const f = film({ title: "NoRelease", tmdbId: 4, platform: "Netflix", verdict: "confirm", withRelease: false });
    expect(resolvePlatformFill(f)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("DETERMINISM AND THE GATE HASH (item 5)", () => {
  const noEligible = () => [ottResult([aroopi(), september21()])];

  it("a deck with NO seam-eligible film hashes byte-identically with the seam present", () => {
    const before = computeDropHash(noEligible());
    const results = noEligible();
    expect(fillConfirmedPlatforms(results)).toEqual([]);   // nothing eligible
    expect(computeDropHash(results)).toBe(before);
  });

  it("the seam is a no-op on a deck it cannot touch — deep equality, not just the hash", () => {
    const results = noEligible();
    const snapshot = JSON.stringify(results);
    fillConfirmedPlatforms(results);
    expect(JSON.stringify(results)).toBe(snapshot);
  });

  it("same inputs → same hash, run after run", () => {
    const h = () => { const r = [ottResult([kattalan(), aakhri()])]; fillConfirmedPlatforms(r); enforceVerification(r, ENFORCE); return computeDropHash(r); };
    expect(h()).toBe(h());
    expect(h()).toBe(h());
  });

  it("IDEMPOTENT — a second pass fills nothing and moves nothing", () => {
    const results = [ottResult([kattalan(), aakhri()])];
    expect(fillConfirmedPlatforms(results)).toHaveLength(2);
    const afterFirst = JSON.stringify(results);
    const hashFirst = computeDropHash(results);

    expect(fillConfirmedPlatforms(results)).toEqual([]);   // already filled ⇒ ineligible
    expect(JSON.stringify(results)).toBe(afterFirst);
    expect(computeDropHash(results)).toBe(hashFirst);
  });

  it("the review run and its --approve re-run agree, so the token stays valid", () => {
    const run = () => { const r = [ottResult([kattalan(), aakhri(), aroopi(), september21()])]; fillConfirmedPlatforms(r); enforceVerification(r, ENFORCE); return r; };
    const review = run();
    const approve = run();
    const hash = computeDropHash(review);
    expect(computeDropHash(approve)).toBe(hash);
    expect(decideGate(approve, { alwaysGate: true, approveHash: hash }).mode).toBe("approved");
  });

  it("the hash DOES move when the seam rescues a film — the approved set really changed", () => {
    // Not a regression: the rendered deck differs, so --approve must re-bind.
    const without = [ottResult([kattalan()])];
    enforceVerification(without, ENFORCE);
    const withSeam = [ottResult([kattalan()])];
    fillConfirmedPlatforms(withSeam);
    enforceVerification(withSeam, ENFORCE);
    expect(computeDropHash(withSeam)).not.toBe(computeDropHash(without));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("SCOPE — the seam fills the field and changes nothing else", () => {
  it("tier, date, status, foundIn and the entry string are all untouched", () => {
    const f = kattalan();
    const { tier, date, dateSource, status, platform } = f;
    const foundIn = [...f.foundIn];
    fillConfirmedPlatforms([ottResult([f])]);
    expect({ tier: f.tier, date: f.date, dateSource: f.dateSource, status: f.status, platform: f.platform })
      .toEqual({ tier, date, dateSource, status, platform });
    expect(f.foundIn).toEqual(foundIn);
  });

  it("it neither demotes nor promotes — enforcement remains the only classifier", () => {
    const results = [ottResult([kattalan(), aakhri(), september21()])];
    fillConfirmedPlatforms(results);
    for (const f of results[0]!.reconciled) {
      expect(f.aiDemoted).toBeUndefined();
      expect(f.aiPromoted).toBeUndefined();
      expect(f.platformSuppressed).toBeUndefined();
    }
  });

  it("theatrical films are filled too, but were never subject to the OTT platform rule", () => {
    const f = film({ title: "T", tmdbId: 5, platform: "ManoramaMAX", verdict: "confirm" });
    f.pillar = "theatrical";
    const results: ReconcileResult[] = [{ ...ottResult([f]), pillar: "theatrical" }];
    fillConfirmedPlatforms(results);
    expect(f.release!.platform).toEqual(["ManoramaMAX"]);
    enforceVerification(results, ENFORCE);
    expect(f.aiDemoted).toBeUndefined();
  });
});
