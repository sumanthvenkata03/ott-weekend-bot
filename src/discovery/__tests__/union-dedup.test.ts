// union-dedup.test.ts — pins the cross-net union/dedupe (unionFilms + dedupeKey).
//
// These are pure functions, but they live in index.ts, which imports both nets;
// importing index.ts therefore drags in tmdb.js (config.exit + SQLite) and
// wikipediaList.js (SQLite + ofetch). The three hoisted mocks below neutralize
// those import-time side effects so the suite stays offline and cache-free.
import { describe, it, expect, vi } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("../../shared/cache.js", () => ({ cached: (_k: string, loader: () => unknown) => loader() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({ tmdbFetchCached: vi.fn() }));

import { unionFilms, dedupeKey } from "../index.js";
import { normalizeTitle } from "../normalize.js";
import type { DiscoveredFilm, DiscoverySource, ReleaseType } from "../types.js";

interface Spec {
  title: string;
  found: DiscoverySource;
  language?: string;
  year?: number;
  releaseDate?: string;
  approximateDate?: boolean;
  releaseType?: ReleaseType;
  tmdbId?: number;
  note?: string;
  normalizedTitle?: string;
}

// Build a DiscoveredFilm with only the supplied fields (exactOptionalPropertyTypes
// forbids assigning explicit `undefined`, hence the conditional spreads).
function film(s: Spec): DiscoveredFilm {
  const perSource =
    s.found === "tmdb"
      ? {
          tmdb: {
            tmdbId: s.tmdbId ?? 0,
            title: s.title,
            ...(s.releaseDate ? { releaseDate: s.releaseDate } : {}),
            ...(s.language ? { language: s.language } : {}),
            ...(s.releaseType ? { releaseType: s.releaseType } : {}),
          },
        }
      : {
          wikipedia: {
            title: s.title,
            ...(s.releaseDate ? { releaseDate: s.releaseDate } : {}),
            ...(s.approximateDate ? { approximateDate: true } : {}),
            ...(s.language ? { language: s.language } : {}),
            page: "p",
          },
        };
  return {
    title: s.title,
    normalizedTitle: s.normalizedTitle ?? normalizeTitle(s.title),
    ...(s.year !== undefined ? { year: s.year } : {}),
    ...(s.language ? { language: s.language } : {}),
    ...(s.releaseDate ? { releaseDate: s.releaseDate } : {}),
    ...(s.approximateDate ? { approximateDate: true } : {}),
    ...(s.releaseType ? { releaseType: s.releaseType } : {}),
    ...(s.tmdbId !== undefined ? { tmdbId: s.tmdbId } : {}),
    ...(s.note ? { note: s.note } : {}),
    foundIn: [s.found],
    perSource,
  };
}

describe("unionFilms — cross-net merge", () => {
  it("same film found by BOTH nets collapses to one row with merged provenance", () => {
    const t = film({ title: "Mathru", found: "tmdb", language: "Telugu", year: 2026, releaseDate: "2026-02-05", releaseType: "digital", tmdbId: 1528181 });
    const w = film({ title: "Mathru", found: "wikipedia", language: "Telugu", year: 2026, releaseDate: "2026-02-05" });
    const out = unionFilms([t, w]);
    expect(out).toHaveLength(1);
    expect(out[0]?.foundIn.sort()).toEqual(["tmdb", "wikipedia"]);
    expect(out[0]?.perSource.tmdb).toBeDefined();
    expect(out[0]?.perSource.wikipedia).toBeDefined();
    expect(out[0]?.tmdbId).toBe(1528181);
    expect(out[0]?.releaseType).toBe("digital");
  });

  it("🔒 & ↔ and converge across nets -> a single merged film", () => {
    const t = film({ title: "Parimala and Co", found: "tmdb", language: "Kannada", year: 2026, tmdbId: 42, releaseDate: "2026-04-10" });
    const w = film({ title: "Parimala & Co", found: "wikipedia", language: "Kannada", year: 2026, releaseDate: "2026-04-10" });
    expect(dedupeKey(t)).toBe(dedupeKey(w));
    expect(unionFilms([t, w])).toHaveLength(1);
  });

  it("does not mutate the input arrays", () => {
    const t = film({ title: "Mathru", found: "tmdb", language: "Telugu", year: 2026 });
    const w = film({ title: "Mathru", found: "wikipedia", language: "Telugu", year: 2026 });
    unionFilms([t, w]);
    expect(t.foundIn).toEqual(["tmdb"]);
    expect(w.foundIn).toEqual(["wikipedia"]);
  });
});

describe("unionFilms — must NOT merge (🔒 wrong-merge guards)", () => {
  it("🔒 same title in different LANGUAGES stays separate (Drishyam 3 hi/ml, Vikalpa te/kn)", () => {
    const drishyamHi = film({ title: "Drishyam 3", found: "tmdb", language: "Hindi", year: 2026, tmdbId: 1 });
    const drishyamMl = film({ title: "Drishyam 3", found: "tmdb", language: "Malayalam", year: 2026, tmdbId: 2 });
    const vikalpaTe = film({ title: "Vikalpa", found: "wikipedia", language: "Telugu", year: 2026 });
    const vikalpaKn = film({ title: "Vikalpa", found: "wikipedia", language: "Kannada", year: 2026 });
    expect(dedupeKey(drishyamHi)).not.toBe(dedupeKey(drishyamMl));
    expect(unionFilms([drishyamHi, drishyamMl, vikalpaTe, vikalpaKn])).toHaveLength(4);
  });

  it("🔒 sequels never merge with their base film", () => {
    const a = film({ title: "Pushpa", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 10 });
    const b = film({ title: "Pushpa 2", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 11 });
    expect(unionFilms([a, b])).toHaveLength(2);
  });

  it("🔒 transliteration variants stay SEPARATE — Moondraam vs Moondram (deferred: needs an LLM matcher)", () => {
    // INTENTIONAL FOR NOW. A purely-algorithmic normalizer cannot know these are
    // the same film; merging them would require fuzzy/transliteration matching,
    // which is deferred to a future LLM pass. Pinned so the current (safe,
    // never-wrong-merge) behavior is explicit.
    const a = film({ title: "Moondraam", found: "wikipedia", language: "Tamil", year: 2026 });
    const b = film({ title: "Moondram", found: "tmdb", language: "Tamil", year: 2026, tmdbId: 99 });
    expect(normalizeTitle("Moondraam")).not.toBe(normalizeTitle("Moondram"));
    expect(unionFilms([a, b])).toHaveLength(2);
  });

  it("two TMDb rows sharing a key collapse to one (the theatrical+digital->'both' join is the net's job, see tmdb-discover)", () => {
    const a = film({ title: "Same", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 5, releaseType: "both" });
    const b = film({ title: "Same", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 5, releaseType: "both" });
    expect(unionFilms([a, b])).toHaveLength(1);
  });
});

describe("unionFilms — date preference & stats inputs", () => {
  it("🔒 prefers a concrete date over an approximate one, regardless of merge order", () => {
    const approx = film({ title: "X", found: "tmdb", language: "Telugu", year: 2026, releaseDate: "2026-02-01", approximateDate: true, note: "in-range digital release; date shown is TMDb primary date", tmdbId: 7 });
    const concrete = film({ title: "X", found: "wikipedia", language: "Telugu", year: 2026, releaseDate: "2026-02-05" });

    const approxFirst = unionFilms([approx, concrete])[0];
    expect(approxFirst?.releaseDate).toBe("2026-02-05");
    expect(approxFirst?.approximateDate).toBeUndefined(); // concrete date drops the flag…
    expect(approxFirst?.note).toBeUndefined(); // …and its caveat note

    const concreteFirst = unionFilms([concrete, approx])[0];
    expect(concreteFirst?.releaseDate).toBe("2026-02-05");
    expect(concreteFirst?.approximateDate).toBeUndefined();
  });

  it("foundIn classification (the input to onlyInTmdb/onlyInWikipedia/inBoth stats) is correct", () => {
    const out = unionFilms([
      film({ title: "TmdbOnly", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 1 }),
      film({ title: "WikiOnly", found: "wikipedia", language: "Telugu", year: 2026 }),
      film({ title: "Shared", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 2 }),
      film({ title: "Shared", found: "wikipedia", language: "Telugu", year: 2026 }),
    ]);
    expect(out).toHaveLength(3);
    const onlyTmdb = out.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "tmdb").length;
    const onlyWiki = out.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "wikipedia").length;
    const both = out.filter((f) => f.foundIn.includes("tmdb") && f.foundIn.includes("wikipedia")).length;
    expect([onlyTmdb, onlyWiki, both]).toEqual([1, 1, 1]);
  });
});

describe("dedupeKey", () => {
  it("is normalizedTitle | language | year", () => {
    expect(dedupeKey(film({ title: "Mathru", found: "tmdb", language: "Telugu", year: 2026 }))).toBe("mathru|Telugu|2026");
  });
  it("missing language/year degrade to empty segments (still a stable key)", () => {
    expect(dedupeKey(film({ title: "Mathru", found: "tmdb" }))).toBe("mathru||");
  });
});
