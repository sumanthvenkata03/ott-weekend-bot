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

  it("🔒 same tmdbId but DIFFERENT dedupeKey (year) → merged to ONE (Blast theatrical-2025 vs ott-2026)", () => {
    // The cross-release-type case: the TMDb digital pass dates a film by its
    // primary (2025) date while the AI-OTT net dates it by the press OTT (2026)
    // date — different dedupeKeys, but a shared tmdbId means ONE film.
    const a = film({ title: "Blast", found: "tmdb", language: "Tamil", year: 2025, tmdbId: 55555, releaseType: "theatrical" });
    const b = film({ title: "Blast", found: "tmdb", language: "Tamil", year: 2026, tmdbId: 55555, releaseType: "digital" });
    expect(dedupeKey(a)).not.toBe(dedupeKey(b)); // different keys (year differs)…
    const out = unionFilms([a, b]);
    expect(out).toHaveLength(1);                  // …but the shared tmdbId collapses them
    expect(out[0]?.tmdbId).toBe(55555);
  });

  it("🔒 the tmdbId-merge does NOT collapse the possibleDistinct case (DIFFERENT ids, same title → still TWO + flagged)", () => {
    const a = film({ title: "Vimanam", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 301 });
    const b = film({ title: "Vimanam", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 302 });
    const out = unionFilms([a, b]);
    expect(out).toHaveLength(2); // distinct ids ⇒ never merged by the tmdbId pass
    expect(out.every((f) => f.possibleDistinct === true)).toBe(true);
  });

  it("🔒 same title|language|year but DIFFERENT tmdbIds do NOT merge — both survive, flagged possibleDistinct", () => {
    // A remake / same-title same-year namesake. The old behavior dropped the
    // 2nd film and its tmdbId; the guard keeps both and flags the collision.
    const a = film({ title: "Vikalpa", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 100 });
    const b = film({ title: "Vikalpa", found: "tmdb", language: "Telugu", year: 2026, tmdbId: 200 });
    expect(dedupeKey(a)).toBe(dedupeKey(b)); // same base key…
    const out = unionFilms([a, b]);
    expect(out).toHaveLength(2); // …but NOT merged
    expect(out.map((f) => f.tmdbId).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([100, 200]); // both ids survive
    expect(out.every((f) => f.possibleDistinct === true)).toBe(true); // both flagged
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
