// verdict-select.test.ts — the deterministic Sat Verdict card selector.
// Anchors the "card every judged film, no cap" policy: every Must Watch /
// Worth a Try / Skip earns a card, trimmedSkips is always empty (so the cover
// can never name an un-carded film), ordered hero-first by tier then importance.
import { describe, it, expect, vi } from "vitest";
import { selectVerdictCards, verdictKind, MAX_VERDICT_CARDS, type VerdictEntry } from "./verdict-select.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { VerdictSlide } from "../../delivery/notion.js";
import type { VerdictResearch } from "./verdict-research.js";

/** Minimal VerdictEntry fake — only the fields the selector reads. */
function entry(title: string, verdict: VerdictSlide["verdict"], pop?: number): VerdictEntry {
  const slide = { filmTitle: title, verdict } as unknown as VerdictSlide;
  const release = (pop === undefined ? { title } : { title, tmdbPopularity: pop }) as unknown as Release;
  return { slide, release, research: {} as VerdictResearch };
}

const titles = (es: VerdictEntry[]) => es.map(e => e.slide.filmTitle);

describe("selectVerdictCards — cards every judged film (no cap)", () => {
  it("cards every Skip too — the 3rd+ Skip is no longer trimmed", () => {
    const entries = [
      entry("M1", "🔥 Must Watch", 10),
      entry("W1", "👀 Worth a Try", 8),
      entry("S1", "⏭️ Skip", 5),
      entry("S2", "⏭️ Skip", 4),
      entry("S3", "⏭️ Skip", 3), // previously trimmed by MAX_SKIP_CARDS=2
    ];
    const { selected, trimmedSkips } = selectVerdictCards(entries);
    expect(selected).toHaveLength(5);
    expect(trimmedSkips).toHaveLength(0);
    expect(titles(selected)).toContain("S3");
  });

  it("orders hero-first by tier: Must Watch → Worth a Try → Skip", () => {
    const entries = [
      entry("S-big", "⏭️ Skip", 100),
      entry("W-big", "👀 Worth a Try", 50),
      entry("M-small", "🔥 Must Watch", 1),
    ];
    expect(titles(selectVerdictCards(entries).selected)).toEqual(["M-small", "W-big", "S-big"]);
  });

  it("orders within a tier by importance (tmdbPopularity desc)", () => {
    const entries = [entry("S-lo", "⏭️ Skip", 1), entry("S-hi", "⏭️ Skip", 9)];
    expect(titles(selectVerdictCards(entries).selected)).toEqual(["S-hi", "S-lo"]);
  });

  it("a missing tmdbPopularity sorts last within its tier", () => {
    const entries = [entry("no-pop", "⏭️ Skip"), entry("pop", "⏭️ Skip", 1)];
    expect(titles(selectVerdictCards(entries).selected)).toEqual(["pop", "no-pop"]);
  });

  it("empty input → empty selection, empty trimmedSkips", () => {
    expect(selectVerdictCards([])).toEqual({ selected: [], trimmedSkips: [] });
  });
});

describe("selectVerdictCards — soft ceiling (MAX_VERDICT_CARDS)", () => {
  const MUST = "🔥 Must Watch" as const;
  const WORTH = "👀 Worth a Try" as const;
  const OTW = "🎟️ One-Time Watch" as const;
  const SKIP = "⏭️ Skip" as const;

  it("12 films (2 MW, 2 WaT, 1 One-Time Watch, 7 Skip) → 10 cards; only the 2 lowest Skips overflow, tier order preserved", () => {
    const entries = [
      entry("MW1", MUST, 100), entry("MW2", MUST, 90),
      entry("WT1", WORTH, 85), entry("WT2", WORTH, 80),
      entry("OT1", OTW, 77),
      entry("SK1", SKIP, 70), entry("SK2", SKIP, 60), entry("SK3", SKIP, 50),
      entry("SK4", SKIP, 40), entry("SK5", SKIP, 30), entry("SK6", SKIP, 20), entry("SK7", SKIP, 10),
    ];
    const { selected, trimmedSkips } = selectVerdictCards(entries);
    expect(selected).toHaveLength(MAX_VERDICT_CARDS); // 10
    // tier order must-watch → worth-a-try → one-time-watch → skip; One-Time Watch is NEVER trimmed
    expect(titles(selected)).toEqual(["MW1", "MW2", "WT1", "WT2", "OT1", "SK1", "SK2", "SK3", "SK4", "SK5"]);
    expect(titles(trimmedSkips)).toEqual(["SK6", "SK7"]); // 2 lowest-importance Skips, order preserved
    // INVARIANT: only Skips ever overflow
    expect(trimmedSkips.every(e => e.slide.verdict === SKIP)).toBe(true);
  });

  it("One-Time Watch is NEVER trimmed even when non-Skip fills every slot — only Skips overflow", () => {
    // 10 One-Time Watch films already fill the ceiling; 3 Skips must ALL overflow,
    // and no One-Time Watch may ever enter trimmedSkips.
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => entry(`OT${i}`, OTW, 100 - i)),
      entry("SK1", SKIP, 5), entry("SK2", SKIP, 4), entry("SK3", SKIP, 3),
    ];
    const { selected, trimmedSkips } = selectVerdictCards(entries);
    expect(selected).toHaveLength(MAX_VERDICT_CARDS); // 10 — all One-Time Watch
    expect(selected.every(e => e.slide.verdict === OTW)).toBe(true);
    expect(titles(trimmedSkips)).toEqual(["SK1", "SK2", "SK3"]);
    expect(trimmedSkips.every(e => e.slide.verdict === SKIP)).toBe(true); // never a One-Time Watch
  });

  it("exactly 10 films → 10 cards, trimmedSkips empty (ceiling not exceeded)", () => {
    const entries = [
      entry("MW1", MUST, 100), entry("MW2", MUST, 90),
      entry("WT1", WORTH, 80), entry("WT2", WORTH, 70), entry("WT3", WORTH, 60),
      entry("SK1", SKIP, 50), entry("SK2", SKIP, 40), entry("SK3", SKIP, 30),
      entry("SK4", SKIP, 20), entry("SK5", SKIP, 10),
    ];
    const { selected, trimmedSkips } = selectVerdictCards(entries);
    expect(selected).toHaveLength(10);
    expect(trimmedSkips).toHaveLength(0);
  });

  it("11 non-Skip films (incl. One-Time Watch) → all 11 carded, trimmedSkips empty, warning logged (ceiling yields)", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const entries = [
      ...Array.from({ length: 4 }, (_, i) => entry(`MW${i}`, MUST, 100 - i)),
      ...Array.from({ length: 4 }, (_, i) => entry(`WT${i}`, WORTH, 60 - i)),
      ...Array.from({ length: 3 }, (_, i) => entry(`OT${i}`, OTW, 30 - i)),
    ];
    const { selected, trimmedSkips } = selectVerdictCards(entries);
    expect(selected).toHaveLength(11); // ceiling yields — One-Time Watch counts as non-Skip, never trimmed
    expect(trimmedSkips).toHaveLength(0); // only Skips may overflow; there are none
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("verdictKind — emoji → kind mapping (incl. One-Time Watch)", () => {
  it("maps every tier, and 🎟️ One-Time Watch → one-time-watch", () => {
    expect(verdictKind("🔥 Must Watch")).toBe("must-watch");
    expect(verdictKind("👀 Worth a Try")).toBe("worth-a-try");
    expect(verdictKind("🎟️ One-Time Watch")).toBe("one-time-watch");
    expect(verdictKind("⏭️ Skip")).toBe("skip");
  });
});

describe("selectVerdictCards — One-Time Watch tier ordering", () => {
  it("orders must-watch → worth-a-try → one-time-watch → skip", () => {
    const entries = [
      entry("SK", "⏭️ Skip", 100),
      entry("OT", "🎟️ One-Time Watch", 90),
      entry("WT", "👀 Worth a Try", 80),
      entry("MW", "🔥 Must Watch", 1),
    ];
    expect(titles(selectVerdictCards(entries).selected)).toEqual(["MW", "WT", "OT", "SK"]);
  });
});
