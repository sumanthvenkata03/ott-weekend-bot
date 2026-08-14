// WD-ENG-16B — THE SHABARA FIX: re-assess once the record is whole.
//
// ── WHAT WD-ENG-16 ACTUALLY FOUND ───────────────────────────────────────────
// assessDates was never broken and its 2-day threshold was never wrong. On the
// AI-net-only path it was CALLED TOO EARLY: buildFromNewAi invokes it as
// assessDates(null, ai, window), so `all` holds one date and nothing can
// conflict. The TMDb date arrives afterwards, when enrichAiNetFilms swaps in the
// enriched Release and mergeReleaseDates prefers TMDb's releaseDates.theatrical.
//
// Shabara: admitted on press 2026-08-14, enriched to TMDb 2026-10-02, tiered
// yellow/"single-net" with NO date-conflict, because the tier was decided before
// the second date existed. The manifest caught it and blocked the render — but
// only after the operator approved a review showing ONE date.
//
// So this file pins the ORDERING fix, not a new rule: same function, same
// threshold, asked again with both dates present.
import { describe, it, expect } from "vitest";
import { reassessAfterEnrichment, assignTier } from "../reconcile.js";
import { dateFieldForPillar, qualifyingDate, type BucketWindow } from "../../shared/post-validator.js";
import type { ReconciledFilm } from "../types.js";
import type { Release } from "../../shared/types.js";

const WINDOW = (pillar: string): BucketWindow => ({
  start: "2026-08-12",
  end: "2026-08-16",
  dateField: dateFieldForPillar(pillar),
  label: pillar,
});

function release(over: Partial<Release>): Release {
  return {
    id: "tmdb-1", tmdbId: 1, title: "T", language: "Telugu", isSeries: false,
    platform: [], releaseDate: "", genre: [], cast: [], synopsis: "",
    subtitleLanguages: [], sources: ["ai-net"], fetchedAt: "2026-08-13T00:00:00.000Z",
    ...over,
  } as Release;
}

/** A film as it stands the instant BEFORE enrichment: press date only. */
function film(over: Partial<ReconciledFilm>): ReconciledFilm {
  return {
    title: "T", language: "Telugu", pillar: "theatrical",
    dateSource: "press", foundIn: ["ai-net"], status: "confirmed",
    landingStatus: "pass", tier: "yellow", reasons: ["single-net"],
    ...over,
  } as ReconciledFilm;
}

describe("THE CASE — Shabara's real record", () => {
  // Verbatim from output/runs/wed-drop-2026-08-13-results.json.
  const shabara = () =>
    film({
      title: "Shabara", tmdbId: 1628882, date: "2026-08-14", dateSource: "press",
      release: release({
        id: "tmdb-1628882", tmdbId: 1628882, title: "Shabara",
        releaseDate: "2026-08-14",
        releaseDates: { theatrical: "2026-10-02" },   // ← arrived via enrichment
      }),
    });

  it("PRECONDITION: before the fix it was yellow/single-net with NO conflict", () => {
    const f = shabara();
    expect(f.tier).toBe("yellow");
    expect(f.reasons).toEqual(["single-net"]);
    expect(f.conflictDetail).toBeUndefined();
  });

  it("re-assessment flags the conflict — 49 days apart, both dates present", () => {
    const f = shabara();
    reassessAfterEnrichment(f, WINDOW("theatrical"));

    expect(f.reasons).toContain("date-conflict");
    expect(f.conflictDetail).toBeTruthy();
  });

  it("BOTH dates AND their sources are visible — never a silent winner", () => {
    const f = shabara();
    reassessAfterEnrichment(f, WINDOW("theatrical"));

    // The operator must be able to read which net believed which date.
    expect(f.conflictDetail).toContain("2026-08-14");
    expect(f.conflictDetail).toContain("2026-10-02");
    expect(f.conflictDetail).toContain("press");
    expect(f.conflictDetail).toContain("tmdb:theatrical");
    // And nothing in the record silently elects one of them. Order follows the
    // existing `validDates(tmdbDate, aiDate, …)` construction — TMDb first.
    expect(f.conflictDetail).toBe(
      "dates seen: 2026-10-02 (tmdb:theatrical) vs 2026-08-14 (press)"
    );
  });

  it("it stays a WARN — landing still PASSES, the tier stays yellow", () => {
    const f = shabara();
    reassessAfterEnrichment(f, WINDOW("theatrical"));

    // assessDates passes a film when ANY known date lands in the window — the
    // documented press-date rescue. 2026-08-14 is in window, so landing is
    // "pass" and this packet does NOT change that. What the re-assessment adds
    // is the VISIBLE disagreement at review time.
    expect(f.landingStatus).toBe("pass");
    expect(f.tier).toBe("yellow");
    expect(f.tier).not.toBe("red");

    // The hard block on the PRINTED date remains the manifest's job, unchanged:
    // qualifyingDate reads 2026-10-02, which is outside the window.
    expect(qualifyingDate(f.release!, dateFieldForPillar("theatrical")).date).toBe("2026-10-02");
  });
});

describe("the other historical conflicts from the artifact sweep", () => {
  it.each([
    ["Address", "2026-07-31", "2025-03-07"],
    ["Aasai", "2026-07-31", "2026-03-06"],
  ])("%s flags with both dates named", (title, press, tmdb) => {
    const f = film({
      title, date: press,
      release: release({ releaseDate: press, releaseDates: { theatrical: tmdb } }),
    });
    reassessAfterEnrichment(f, { ...WINDOW("theatrical"), start: "2026-07-29", end: "2026-08-02" });

    expect(f.reasons).toContain("date-conflict");
    expect(f.conflictDetail).toContain(press);
    expect(f.conflictDetail).toContain(tmdb);
  });
});

describe("silence when there is nothing to say", () => {
  it("matching dates → no conflict, tier unchanged", () => {
    const f = film({
      date: "2026-08-14",
      release: release({ releaseDate: "2026-08-14", releaseDates: { theatrical: "2026-08-14" } }),
    });
    const { changed } = reassessAfterEnrichment(f, WINDOW("theatrical"));

    expect(f.conflictDetail).toBeUndefined();
    expect(f.reasons).not.toContain("date-conflict");
    expect(f.tier).toBe("yellow");           // still single-net, unchanged
    expect(changed).toBe(false);
  });

  it("a 2-day difference is INSIDE the existing threshold and stays silent", () => {
    // The threshold is untouched by this packet: >2d conflicts, ≤2d does not.
    const f = film({
      date: "2026-08-14",
      release: release({ releaseDate: "2026-08-14", releaseDates: { theatrical: "2026-08-16" } }),
    });
    reassessAfterEnrichment(f, WINDOW("theatrical"));
    expect(f.conflictDetail).toBeUndefined();
  });
});

describe("a 7-day difference warns but does NOT block the edition", () => {
  // Tera Yaar Hoon Main / Ohh My Dog shape. Both dates land in the window, so
  // the film is publishable; the operator simply sees the disagreement.
  const sevenDay = () =>
    film({
      title: "Tera Yaar Hoon Main", date: "2026-08-13",
      release: release({ releaseDate: "2026-08-13", releaseDates: { theatrical: "2026-08-16" } }),
    });

  it("flags date-conflict", () => {
    const f = sevenDay();
    reassessAfterEnrichment(f, WINDOW("theatrical"));
    expect(f.reasons).toContain("date-conflict");
  });

  it("stays YELLOW and PASSES landing — nothing is blocked", () => {
    const f = sevenDay();
    reassessAfterEnrichment(f, WINDOW("theatrical"));
    expect(f.landingStatus).toBe("pass");
    expect(f.tier).toBe("yellow");
    expect(f.tier).not.toBe("red");
  });
});

describe("THE FALSE-POSITIVE GUARD — the theatre→OTT window is not a conflict", () => {
  // WD-ENG-16's sweep found 102 naive "conflicts", ~50 of which were simply a
  // film's theatrical date sitting months before its OTT date. Comparing those
  // two fields would have flagged half the catalogue. The re-assessment compares
  // the film against THIS PILLAR's field only, which is why these stay silent.
  it.each([
    ["Aakhri Sawal", "2026-05-15", "2026-08-14"],   // 91d
    ["Kattalan", "2026-05-28", "2026-08-13"],       // 77d
  ])("%s (OTT pillar) is NOT flagged despite a %s→%s gap", (title, theatrical, ott) => {
    const f = film({
      title, pillar: "ott", date: ott, dateSource: "tmdb",
      release: release({ releaseDate: ott, releaseDates: { theatrical, ott } }),
    });
    reassessAfterEnrichment(f, WINDOW("ott"));

    expect(f.conflictDetail).toBeUndefined();
    expect(f.reasons).not.toContain("date-conflict");
    expect(f.landingStatus).toBe("pass");
  });

  it("the same record on the THEATRICAL pillar would flag — it is the field, not the film", () => {
    // Proof that the silence above comes from consulting the right field rather
    // than from the check being toothless.
    const f = film({
      title: "Aakhri Sawal", pillar: "theatrical", date: "2026-08-14",
      release: release({ releaseDate: "2026-08-14", releaseDates: { theatrical: "2026-05-15", ott: "2026-08-14" } }),
    });
    reassessAfterEnrichment(f, WINDOW("theatrical"));
    expect(f.reasons).toContain("date-conflict");
  });
});

describe("WD-ENG-16B PART 4 — THE INVARIANT", () => {
  it("assessDates and qualifyingDate consult the SAME field for the same pillar", () => {
    // The Shabara defect was one question answered against two fields. This is
    // the pin: for each pillar, the field the re-assessment reads and the field
    // the manifest reads must be identical.
    for (const pillar of ["ott", "theatrical"]) {
      const win = WINDOW(pillar);
      const r = release({
        releaseDate: "2026-08-14",
        releaseDates: { theatrical: "2026-05-15", ott: "2026-08-13" },
      });
      const manifestReads = qualifyingDate(r, win.dateField).date;
      const expected = pillar === "ott" ? "2026-08-13" : "2026-05-15";
      expect(manifestReads, pillar).toBe(expected);
      expect(win.dateField, pillar).toBe(dateFieldForPillar(pillar));
    }
  });

  it("dateFieldForPillar is the ONE mapping — no inline ternary survives", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/jobs/wednesday-drop.ts"), "utf8");
    // The manifest window and the re-assessment window must both route through
    // the helper; a re-introduced ternary is exactly how the two readers drifted.
    expect(src).not.toMatch(/dateField:\s*\w+\s*===\s*"ott"\s*\?/);
    expect(src).toContain("dateFieldForPillar(vbucket)");
    expect(src).toContain("dateFieldForPillar(result.pillar)");
  });

  it("re-assessment does not invent a tier — it re-runs the existing assignTier", () => {
    // Guards against a future edit hand-rolling tier logic inside the fix.
    const f = film({
      date: "2026-08-14",
      release: release({ releaseDate: "2026-08-14", releaseDates: { theatrical: "2026-10-02" } }),
    });
    reassessAfterEnrichment(f, WINDOW("theatrical"));
    expect(f.reasons).toEqual(assignTier(f).reasons);
    expect(f.tier).toBe(assignTier(f).tier);
  });
});
