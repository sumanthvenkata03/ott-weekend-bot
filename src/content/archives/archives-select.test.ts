// Selection-core tests: the REAL gate (R3), gem-over-famous ranking, pairwise
// genre distinctness, deterministic language rotation, dial parsing, and the
// PERMANENT no-repeat proof (a second selection excludes all of the first's picks).
import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  isGem,
  selectArchives,
  selectArchivesManual,
  rotateLanguages,
  parseLangOverride,
  parsePickOverride,
  parseTreasure,
  archivesCutoffDate,
  minAgeYears,
  ARCHIVES_LANGUAGES,
} from "./archives-select.js";
import type { Release } from "../../shared/types.js";

function mkRelease(p: Partial<Release> & { tmdbId: number }): Release {
  return {
    id: `tmdb-${p.tmdbId}`, title: `F${p.tmdbId}`, language: "Tamil", isSeries: false,
    platform: ["Netflix"], releaseDate: "2019-01-01", genre: ["Drama"], cast: [],
    synopsis: "", subtitleLanguages: [], sources: [], fetchedAt: "",
    imdbRating: 8, imdbVotes: 5000, ...p,
  };
}

// Pure key fn (avoids importing featured-ledger's db-backed module in a unit test).
const key = (r: Pick<Release, "imdbId" | "tmdbId" | "title">) =>
  r.imdbId ?? (r.tmdbId ? `tmdb:${r.tmdbId}` : `title:${r.title}`);

/** A release with NO imdbVotes (exactOptionalPropertyTypes forbids `undefined`). */
function noVotes(r: Release): Release {
  const { imdbVotes: _drop, ...rest } = r;
  return rest as Release;
}

describe("archives gate (R3)", () => {
  it("passes rating ≥ 7.3, votes ≥ 2000, and a platform", () => {
    expect(evaluateGate(mkRelease({ tmdbId: 1, imdbRating: 7.3, imdbVotes: 2000 })).pass).toBe(true);
  });
  it("fails when votes are missing (printed count is the honesty device)", () => {
    const g = evaluateGate(noVotes(mkRelease({ tmdbId: 2, imdbRating: 9 })));
    expect(g.pass).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/votes/);
  });
  it("fails a sub-7.3 rating and a platform-less film", () => {
    expect(evaluateGate(mkRelease({ tmdbId: 3, imdbRating: 7.2 })).pass).toBe(false);
    expect(evaluateGate(mkRelease({ tmdbId: 4, platform: [] })).pass).toBe(false);
  });
});

describe("archives gem window", () => {
  it("≤ 60000 votes is a gem; above is famous", () => {
    expect(isGem(mkRelease({ tmdbId: 1, imdbVotes: 60000 }))).toBe(true);
    expect(isGem(mkRelease({ tmdbId: 2, imdbVotes: 60001 }))).toBe(false);
  });
});

describe("selectArchives", () => {
  it("enforces pairwise-distinct primary genres", () => {
    const cands = [
      mkRelease({ tmdbId: 1, genre: ["Drama"] }),
      mkRelease({ tmdbId: 2, genre: ["Drama"] }), // dup genre → rejected
      mkRelease({ tmdbId: 3, genre: ["Comedy"] }),
      mkRelease({ tmdbId: 4, genre: ["Thriller"] }),
    ];
    const res = selectArchives(cands, { excludedKeys: new Set(), filmKey: key, min: 3, max: 4 });
    const genres = res.picks.map((p) => p.primaryGenre);
    expect(new Set(genres).size).toBe(genres.length);
    expect(res.rejected.some((r) => /genre "Drama" already taken/.test(r.reason))).toBe(true);
  });

  it("ranks a gem above a higher-rated famous title", () => {
    const gem = mkRelease({ tmdbId: 1, genre: ["Drama"], imdbRating: 7.5, imdbVotes: 10000 });
    const famous = mkRelease({ tmdbId: 2, genre: ["Drama"], imdbRating: 9.0, imdbVotes: 80000 });
    const res = selectArchives([famous, gem], { excludedKeys: new Set(), filmKey: key, min: 1, max: 1 });
    expect(res.picks).toHaveLength(1);
    expect(res.picks[0]!.release.tmdbId).toBe(1); // the gem, despite the lower rating
  });

  it("excludes ledger-recorded films (permanent no-repeat)", () => {
    const cands = [
      mkRelease({ tmdbId: 1, genre: ["Drama"] }),
      mkRelease({ tmdbId: 2, genre: ["Comedy"] }),
      mkRelease({ tmdbId: 3, genre: ["Thriller"] }),
      mkRelease({ tmdbId: 4, genre: ["Horror"] }),
    ];
    const run1 = selectArchives(cands, { excludedKeys: new Set(), filmKey: key, min: 3, max: 4 });
    expect(run1.picks.length).toBeGreaterThanOrEqual(3);

    // "Record" run1, then re-select from the SAME candidates.
    const excluded = new Set(run1.picks.map((p) => key(p.release)));
    const run2 = selectArchives(cands, { excludedKeys: excluded, filmKey: key, min: 3, max: 4 });
    for (const p of run2.picks) expect(excluded.has(key(p.release))).toBe(false);
    expect(run2.picks).toHaveLength(0); // all four consumed by run1
  });
});

describe("selectArchivesManual (curated ARCHIVES_PICKS)", () => {
  it("bypasses genre distinctness but never eligibility", () => {
    const cands = [
      mkRelease({ tmdbId: 1, genre: ["Drama"] }),
      mkRelease({ tmdbId: 2, genre: ["Drama"] }), // same genre — allowed when curated
      noVotes(mkRelease({ tmdbId: 3, genre: ["Drama"] })), // fails gate (no votes)
    ];
    const res = selectArchivesManual(cands, [1, 2, 3, 999], { excludedKeys: new Set(), filmKey: key });
    expect(res.picks.map((p) => p.release.tmdbId)).toEqual([1, 2]);
    expect(res.rejected.find((r) => r.title === "F3")).toBeTruthy(); // gate reject
    expect(res.rejected.find((r) => r.title === "tmdb:999")).toBeTruthy(); // no candidate
  });
});

describe("language rotation + dials", () => {
  it("rotates deterministically by volume and stays in-window", () => {
    const v1 = rotateLanguages(1);
    const v2 = rotateLanguages(2);
    expect(v1).toHaveLength(3);
    expect(rotateLanguages(1)).toEqual(v1); // deterministic
    expect(v1).not.toEqual(v2); // consecutive volumes differ
    for (const l of v1) expect(ARCHIVES_LANGUAGES).toContain(l);
  });

  it("an ARCHIVES_LANGS override wins verbatim", () => {
    expect(parseLangOverride("Telugu|Tamil")).toEqual(["Telugu", "Tamil"]);
    expect(rotateLanguages(3, 3, ARCHIVES_LANGUAGES, ["Telugu", "Tamil"])).toEqual(["Telugu", "Tamil"]);
    expect(parseLangOverride("Klingon|Tamil")).toEqual(["Tamil"]); // invalid dropped
  });

  it("parses pick + treasure + age dials", () => {
    expect(parsePickOverride("123, 456 ,x")).toEqual([123, 456]);
    expect(parseTreasure("789")).toBe(789);
    expect(parseTreasure("")).toBeUndefined();
    expect(minAgeYears(undefined)).toBe(2);
    expect(minAgeYears("5")).toBe(5);
  });

  it("archivesCutoffDate subtracts the min-age years from IST today", () => {
    // 2026-07-15 IST − 2yr = 2024-07-15
    const cut = archivesCutoffDate(new Date("2026-07-15T06:00:00Z"), 2);
    expect(cut).toBe("2024-07-15");
  });
});
