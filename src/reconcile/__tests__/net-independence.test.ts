// WD-ENG-19 — THE TIER COUNTS INDEPENDENT NETS; AUTO-PUBLISH DOES NOT.
//
// ── WHAT WD-ENG-18 FOUND ────────────────────────────────────────────────────
// ReconciledFilm.foundIn was HARDCODED to `ai ? ["tmdb","ai-net"] : ["tmdb"]`,
// and the green rule read that pair. So District — which independently confirmed
// Hushar Pittalu's date and language off its own ticketing catalogue — could not
// count, while a scraped press headline could. The tier misreported how well
// evidenced a film actually was.
//
// ── THE TWO RULES, AND WHY THEY MUST STAY APART ─────────────────────────────
// The operator's ruling: widen the TIER, leave AUTO-PUBLISH exactly as narrow.
//   isCorroborated        → "how well evidenced is this film?"   (tier, review)
//   isAutoPublishEligible → "may it ship with nobody looking?"   (gate only)
// Collapsing them would silently widen unattended publishing to every newly-green
// pair, which is the one outcome this packet was told to avoid. Both directions
// are pinned, and so is the fact that they are distinct call sites.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  independenceClasses,
  independentNetCount,
  isCorroborated,
  isAutoPublishEligible,
  discoveryTagsOf,
} from "../net-independence.js";
import { assignTier } from "../reconcile.js";
import type { ReconciledFilm } from "../types.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const film = (foundIn: string[], over: Partial<ReconciledFilm> = {}): ReconciledFilm =>
  ({
    title: "T", language: "Telugu", pillar: "theatrical", tmdbId: 1,
    dateSource: "tmdb", date: "2026-08-14", foundIn,
    status: "confirmed", landingStatus: "pass", tier: "yellow", reasons: [],
    ...over,
  }) as ReconciledFilm;

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1c — the independence graph is ENCODED, not assumed", () => {
  it("each algorithmic catalogue is its own class", () => {
    expect(independenceClasses(["tmdb"])).toEqual(new Set(["tmdb"]));
    expect(independenceClasses(["wikipedia"])).toEqual(new Set(["wikipedia"]));
    expect(independenceClasses(["district"])).toEqual(new Set(["district"]));
  });

  it("🔒 ALL PRESS NETS SHARE ONE CLASS — two of them are ONE observation", () => {
    // Tavily (ai-net), Google News (news) and the Filmibeat roundup
    // (ott-calendar) all read the open web and demonstrably surface the same
    // article. Counting them separately would manufacture agreement out of a
    // single story — the JustWatch/TMDb failure mode WD-ENG-15 named.
    for (const tag of ["ai-net", "ai-ott", "news", "ott-calendar"]) {
      expect(independenceClasses([tag]), tag).toEqual(new Set(["press"]));
    }
    expect(independentNetCount(["ai-net", "news", "ott-calendar"])).toBe(1);
    expect(isCorroborated(["ai-net", "news"])).toBe(false);
  });

  it("ENRICHMENT tags never count — they decorate, they do not discover", () => {
    expect(independentNetCount(["omdb", "mdblist", "tmdb-search"])).toBe(0);
    expect(discoveryTagsOf(["tmdb", "omdb", "mdblist", "tmdb-search", "district"]))
      .toEqual(["tmdb", "district"]);
  });

  it("MANUAL contributes no class — the WD-ENG-11 yellow ceiling holds", () => {
    // Otherwise a manual add plus one net would reach green through the back door,
    // and WD-ENG-11 ruled that no evidence basis promotes a manual entry.
    expect(independentNetCount(["manual"])).toBe(0);
    expect(isCorroborated(["manual", "tmdb"])).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — the TIER counts distinct independent nets", () => {
  it("🔒 THE WIDENING — tmdb + district is now green (the Hushar Pittalu case)", () => {
    const { tier, reasons } = assignTier(film(["tmdb", "district"]));
    expect(tier).toBe("green");
    expect(reasons.join(" ")).not.toContain("single-net");
  });

  it("🔒 NOTHING THAT WAS GREEN CHANGES — tmdb + ai-net is still green", () => {
    expect(assignTier(film(["tmdb", "ai-net"])).tier).toBe("green");
  });

  it("one net alone is still yellow / single-net", () => {
    for (const nets of [["tmdb"], ["district"], ["wikipedia"], ["ai-net"]]) {
      const { tier, reasons } = assignTier(film(nets));
      expect(tier, nets.join("+")).toBe("yellow");
      expect(reasons).toContain("single-net");
    }
  });

  it("two PRESS nets do NOT corroborate — the deliberate tightening", () => {
    const { tier, reasons } = assignTier(film(["ai-net", "news"]));
    expect(tier).toBe("yellow");
    expect(reasons).toContain("single-net");
  });

  it("wikipedia + district corroborate each other with no TMDb at all", () => {
    expect(assignTier(film(["wikipedia", "district"])).tier).toBe("green");
  });

  it("a manual add stays YELLOW even beside a real net — pinned both ways", () => {
    const manual = film(["manual"], {
      status: "unverified",
      manualAdd: { evidenceBasis: "wiki-list", verified: true, assertion: false, sourceUrls: ["https://x"], label: "wiki-list" },
    } as Partial<ReconciledFilm>);
    expect(assignTier(manual).tier).toBe("yellow");
    // …and the independence graph refuses to let it corroborate anything.
    expect(isCorroborated(["manual", "district"])).toBe(false);
  });

  it("other issues still outrank corroboration", () => {
    expect(assignTier(film(["tmdb", "district"], { landingStatus: "warn" })).tier).toBe("yellow");
    expect(assignTier(film(["tmdb", "district"], { conflictDetail: "x vs y" })).tier).toBe("yellow");
    expect(assignTier(film(["tmdb", "district"], { landingStatus: "fail" })).tier).toBe("red");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — AUTO-PUBLISH STAYS NARROW", () => {
  it("🔒 GREEN BY THE WIDENED RULE BUT NOT AUTO-PUBLISHABLE — tmdb + district", () => {
    const f = film(["tmdb", "district"]);
    expect(assignTier(f).tier).toBe("green");          // well evidenced…
    expect(isAutoPublishEligible(f.foundIn)).toBe(false); // …but not unattended-shippable
  });

  it("🔒 EVERYTHING AUTO-PUBLISHABLE BEFORE STILL IS — tmdb + ai-net", () => {
    expect(isAutoPublishEligible(["tmdb", "ai-net"])).toBe(true);
    expect(isAutoPublishEligible(["tmdb", "ai-net", "district", "wikipedia"])).toBe(true);
  });

  it("the narrow rule is exactly today's — tmdb AND ai-net, nothing else", () => {
    expect(isAutoPublishEligible(["tmdb"])).toBe(false);
    expect(isAutoPublishEligible(["ai-net"])).toBe(false);
    expect(isAutoPublishEligible(["wikipedia", "district"])).toBe(false);
    expect(isAutoPublishEligible(["manual", "tmdb"])).toBe(false);
  });

  it("🔒 THE TWO RULES ARE DISTINCT CALL SITES — a future merge fails here", () => {
    // The whole point of WD-ENG-19: reporting evidence and shipping unattended
    // must not be the same check. If someone simplifies isEffectiveGreen back to
    // `f.tier === "green"`, auto-publish silently widens and this test catches it.
    const gate = read("src/reconcile/gate.ts");
    expect(gate).toContain("isAutoPublishEligible(f.foundIn)");
    expect(gate).toMatch(/f\.tier === "green" && isAutoPublishEligible/);

    const reconcile = read("src/reconcile/reconcile.ts");
    expect(reconcile).toContain("isCorroborated(f.foundIn)");
    // The tier must NOT consult the auto-publish predicate, or the split is fake.
    expect(reconcile).not.toContain("isAutoPublishEligible");
    // …and the gate must not decide tiers.
    expect(gate).not.toContain("isCorroborated(");
  });

  it("the widened green + narrow gate reproduces the OLD auto-publish set exactly", () => {
    // old-green == (tmdb && ai-net) && no-other-issues.
    // new: tier green (≥2 classes, no issues) AND isAutoPublishEligible.
    // Since tmdb+ai-net is always ≥2 classes, the two are equivalent — asserted
    // over the pairs that actually occur.
    const cases: Array<[string[], boolean]> = [
      [["tmdb", "ai-net"], true],
      [["tmdb"], false],
      [["ai-net"], false],
      [["tmdb", "district"], false],
      [["tmdb", "wikipedia"], false],
      [["wikipedia", "district"], false],
      [["ai-net", "news"], false],
    ];
    for (const [nets, expected] of cases) {
      const f = film(nets);
      const newGate = assignTier(f).tier === "green" && isAutoPublishEligible(f.foundIn);
      const oldGate = nets.includes("tmdb") && nets.includes("ai-net");
      expect(newGate, nets.join("+")).toBe(expected);
      expect(newGate, `${nets.join("+")} must match the OLD rule`).toBe(oldGate);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — discovery provenance actually reaches foundIn", () => {
  it("buildFromPool threads r.sources instead of hardcoding the pair", () => {
    const src = read("src/reconcile/reconcile.ts");
    expect(src).toContain("discoveryTagsOf(r.sources)");
    // The hardcoded literal is gone.
    expect(src).not.toContain('foundIn: ai ? ["tmdb", "ai-net"] : ["tmdb"]');
  });

  it("the type comment no longer claims foundIn is only tmdb/ai-net", () => {
    const t = read("src/reconcile/types.ts");
    expect(t).not.toContain('subset of ["tmdb","ai-net"]');
  });
});
