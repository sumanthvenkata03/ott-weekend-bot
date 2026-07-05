// scripts/movie-lookup/tool.check.ts
// Tool-local tests for the movie-lookup tool. Named *.check.ts (NOT *.test.ts)
// so the repo's default `npx vitest run` never collects them — the main suite
// stays exactly 190. Run these with the tool config:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Offline: cache.js (SQLite side-effect) and ofetch (network) are mocked, so no
// SQLite is opened, no cache.sqlite is written, and no live call is made.

import { describe, it, expect, vi, beforeAll } from "vitest";

// Keep SQLite out of the import graph (tmdb.js -> shared/cache.js opens the DB).
vi.mock("../../src/shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));
// Keep the network out.
vi.mock("ofetch", () => ({ ofetch: vi.fn() }));

import { ofetch } from "ofetch";
import { parseQuery, rankHits, type MultiHit } from "./search.js";
import { tmdbSource, dedupeImages, dedupeVideos, type ImageItem, type VideoItem } from "./sources.js";
import { overlapRatio, titleTokens } from "./wiki.js";

beforeAll(() => { process.env.TMDB_API_KEY = "test-key"; });

const HITS: MultiHit[] = [
  { id: 1, media_type: "movie", title: "Boss", original_language: "en", release_date: "2011-06-01", popularity: 50, vote_count: 500 },
  { id: 2, media_type: "movie", title: "Boss", original_language: "te", release_date: "2006-05-05", popularity: 5, vote_count: 20 },
  { id: 3, media_type: "movie", title: "Boss Level", original_language: "en", release_date: "2021-03-05", popularity: 90, vote_count: 1500 },
  { id: 4, media_type: "tv", title: "Who's the Boss?", original_language: "en", first_air_date: "1984-09-20", popularity: 30, vote_count: 200 },
];

describe("parseQuery — tokenize + soft signals", () => {
  it("is order-independent (same queryString + signals regardless of word order)", () => {
    const a = parseQuery("boss telugu");
    const b = parseQuery("telugu boss");
    expect(a.queryString).toBe(b.queryString);
    expect(a.titleTokens).toEqual(b.titleTokens);
    expect(a.langCodes).toEqual(["te"]);
    expect(b.langCodes).toEqual(["te"]);
    expect(a.titleTokens).toEqual(["boss"]);
  });
  it("recognises a 4-digit year as a signal, not a title token", () => {
    const p = parseQuery("boss 2006");
    expect(p.year).toBe(2006);
    expect(p.titleTokens).toEqual(["boss"]);
  });
  it("language-only query still searches (falls back to the words)", () => {
    const p = parseQuery("telugu");
    expect(p.titleTokens).toEqual(["telugu"]);
  });
});

describe("rankHits — ranking is order-independent + soft boosts", () => {
  it("'boss telugu' == 'telugu boss' (identical ranked id order)", () => {
    const ids = (q: string) => rankHits(parseQuery(q), HITS).map((r) => `${r.mediaType}:${r.id}`);
    expect(ids("boss telugu")).toEqual(ids("telugu boss"));
  });
  it("language signal boosts the right-language title to the TOP", () => {
    const top = rankHits(parseQuery("boss telugu"), HITS)[0];
    expect(top!.id).toBe(2); // Telugu "Boss" wins with +language boost
    expect(top!.language).toBe("Telugu");
  });
  it("WITHOUT a language signal, the more popular English 'Boss' outranks the Telugu one (not excluded)", () => {
    const ranked = rankHits(parseQuery("boss"), HITS);
    const eng = ranked.find((r) => r.id === 1)!;
    const te = ranked.find((r) => r.id === 2)!;
    expect(eng.score).toBeGreaterThan(te.score);
  });
  it("a NON-matching language is SOFT — the film still appears, just not boosted", () => {
    const ranked = rankHits(parseQuery("boss tamil"), HITS);
    expect(ranked.some((r) => r.id === 2)).toBe(true); // Telugu Boss NOT excluded by 'tamil'
  });
  it("year signal boosts the matching-year title to the top", () => {
    const top = rankHits(parseQuery("boss 2006"), HITS)[0];
    expect(top!.id).toBe(2); // 2006 Telugu Boss
  });
  it("dedupes by mediaType:id", () => {
    const dup = [...HITS, { id: 1, media_type: "movie", title: "Boss", original_language: "en", release_date: "2011-06-01" }];
    const ranked = rankHits(parseQuery("boss"), dup as MultiHit[]);
    expect(ranked.filter((r) => r.id === 1 && r.mediaType === "movie").length).toBe(1);
  });
  it("includes series (tv) results, labelled", () => {
    const ranked = rankHits(parseQuery("boss"), HITS);
    expect(ranked.some((r) => r.mediaType === "tv")).toBe(true);
  });
});

describe("adapter aggregation/dedupe", () => {
  it("dedupeImages drops repeated full URLs", () => {
    const items: ImageItem[] = [
      { source: "tmdb", kind: "poster", fullUrl: "u1", thumbUrl: "t1" },
      { source: "omdb", kind: "poster", fullUrl: "u1", thumbUrl: "t1" },
      { source: "tmdb", kind: "backdrop", fullUrl: "u2", thumbUrl: "t2" },
    ];
    expect(dedupeImages(items).map((i) => i.fullUrl)).toEqual(["u1", "u2"]);
  });
  it("dedupeVideos drops repeated site:key", () => {
    const vids: VideoItem[] = [
      { source: "tmdb", site: "YouTube", key: "abc", name: "T", type: "Trailer", official: true, url: "x" },
      { source: "tmdb", site: "YouTube", key: "abc", name: "T2", type: "Teaser", official: false, url: "y" },
      { source: "tmdb", site: "YouTube", key: "def", name: "C", type: "Clip", official: false, url: "z" },
    ];
    expect(dedupeVideos(vids).map((v) => v.key)).toEqual(["abc", "def"]);
  });
});

describe("tmdb adapter shapes (mocked network)", () => {
  it("getMovieImages builds full-res + thumb URLs and tags source", async () => {
    vi.mocked(ofetch).mockResolvedValueOnce({
      id: 1, posters: [{ file_path: "/p.jpg", width: 2000, height: 3000, vote_average: 5, iso_639_1: "te" }],
      backdrops: [{ file_path: "/b.jpg", width: 3840, height: 2160, vote_average: 4, iso_639_1: null }],
    });
    const { items, raw } = await tmdbSource.getMovieImages({ tmdbId: 1 });
    const poster = items.find((i) => i.kind === "poster")!;
    expect(poster.source).toBe("tmdb");
    expect(poster.fullUrl).toBe("https://image.tmdb.org/t/p/original/p.jpg");
    expect(poster.thumbUrl).toBe("https://image.tmdb.org/t/p/w342/p.jpg");
    expect(poster.language).toBe("Telugu");
    expect(items.some((i) => i.kind === "backdrop")).toBe(true);
    expect(raw).toBeTruthy();
  });
  it("getMovieVideos maps YouTube to a watch URL + thumbnail and sorts official trailers first", async () => {
    vi.mocked(ofetch).mockResolvedValueOnce({
      id: 1, results: [
        { key: "clipKey", site: "YouTube", type: "Clip", name: "A clip", official: false },
        { key: "trailerKey", site: "YouTube", type: "Trailer", name: "Official Trailer", official: true },
      ],
    });
    const { items } = await tmdbSource.getMovieVideos!({ tmdbId: 1 });
    expect(items[0]!.name).toBe("Official Trailer"); // official trailer sorts first
    expect(items[0]!.url).toBe("https://www.youtube.com/watch?v=trailerKey");
    expect(items[0]!.thumbUrl).toBe("https://img.youtube.com/vi/trailerKey/hqdefault.jpg");
  });
});

describe("wikipedia matching helpers", () => {
  it("titleTokens strips stopwords, punctuation, and parenthetical disambiguators", () => {
    // "(2019 film)" is a disambiguator — dropped so it doesn't skew title overlap.
    expect(titleTokens("The Family Man (2019 film)")).toEqual(["family", "man"]);
    expect(titleTokens("Boss")).toEqual(["boss"]);
  });
  it("overlapRatio is high for the same title, zero for unrelated", () => {
    expect(overlapRatio("Kalki 2898-AD", "Kalki 2898 AD")).toBeGreaterThanOrEqual(0.9);
    expect(overlapRatio("Boss", "Completely Different Movie")).toBe(0);
  });
});
