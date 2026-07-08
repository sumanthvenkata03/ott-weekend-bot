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
import { parseQuery, rankHits, rankCandidates, type MultiHit, type CompanyHit } from "./search.js";
import {
  tmdbSource, fanartSource, tvdbSource, youtubeSource,
  wikidataSource, wikipediaPersonSource, wikipediaLangSource,
  extractWikidataImages, extractCommonsCategory,
  dedupeImages, dedupeVideos, type ImageItem, type VideoItem,
} from "./sources.js";
import { computeAge, buildFilmography, movieProviders, selectStillFilms, filmImagesToStills, personProfile } from "./lookup.js";
import { overlapRatio, titleTokens } from "./wiki.js";
import { runCheck, describeError } from "./keycheck.js";

beforeAll(() => {
  process.env.TMDB_API_KEY = "test-key";
  // Ensure the new-key adapters see NO key so graceful-degradation is deterministic.
  delete process.env.FANART_API_KEY;
  delete process.env.TVDB_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
});

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

describe("new adapters — graceful degradation when the key env var is absent", () => {
  it("Fanart.tv returns empty (no crash) with FANART_API_KEY unset", async () => {
    expect(await fanartSource.getMovieImages({ tmdbId: 1 })).toEqual({ items: [] });
  });
  it("TVDB returns empty (no crash) with TVDB_API_KEY unset", async () => {
    expect(await tvdbSource.getMovieImages({ tmdbId: 1, imdbId: "tt1" })).toEqual({ items: [] });
  });
  it("YouTube returns empty (no crash) with YOUTUBE_API_KEY unset", async () => {
    expect(await youtubeSource.getMovieVideos!({ tmdbId: 1, title: "X" })).toEqual({ items: [] });
  });
  it("YouTube returns empty when a key is present but no title is given", async () => {
    process.env.YOUTUBE_API_KEY = "yt-key";
    try {
      expect(await youtubeSource.getMovieVideos!({ tmdbId: 1 })).toEqual({ items: [] });
    } finally { delete process.env.YOUTUBE_API_KEY; }
  });
});

describe("YouTube adapter mapping (mocked network)", () => {
  it("maps search items to genuine YouTube watch URLs, flags official channels", async () => {
    process.env.YOUTUBE_API_KEY = "yt-key";
    vi.mocked(ofetch).mockResolvedValueOnce({
      items: [{
        id: { videoId: "abc123" },
        snippet: { title: "Official Trailer", channelTitle: "Studio Official", publishedAt: "2024-01-01T00:00:00Z", thumbnails: { medium: { url: "https://i.ytimg.com/vi/abc123/mq.jpg" } } },
      }],
    });
    try {
      const { items } = await youtubeSource.getMovieVideos!({ tmdbId: 1, title: "Film", year: 2024 });
      expect(items[0]!.url).toBe("https://www.youtube.com/watch?v=abc123");
      expect(items[0]!.source).toBe("youtube");
      expect(items[0]!.official).toBe(true);
      expect(items[0]!.channel).toBe("Studio Official");
    } finally { delete process.env.YOUTUBE_API_KEY; }
  });
});

describe("person detail helpers", () => {
  it("computeAge = current age when alive", () => {
    expect(computeAge("1990-06-01", undefined, new Date("2020-06-01"))).toBe(30);
    expect(computeAge("1990-06-02", undefined, new Date("2020-06-01"))).toBe(29); // birthday not yet reached
  });
  it("computeAge = age at death when deathday present", () => {
    expect(computeAge("1950-01-01", "2000-01-01", new Date("2024-01-01"))).toBe(50);
  });
  it("computeAge is undefined for missing/invalid birthday", () => {
    expect(computeAge(undefined, undefined, new Date())).toBeUndefined();
    expect(computeAge("not-a-date", undefined, new Date())).toBeUndefined();
  });
  it("buildFilmography dedupes per film, merges roles, sorts newest-first, builds posters", () => {
    const filmo = buildFilmography({
      cast: [
        { id: 10, title: "New Film", release_date: "2022-05-01", media_type: "movie", character: "Hero", poster_path: "/p.jpg", popularity: 9 },
        { id: 11, name: "Old Show", first_air_date: "2015-01-01", media_type: "tv", character: "Guest" },
      ],
      crew: [
        { id: 10, title: "New Film", release_date: "2022-05-01", media_type: "movie", job: "Producer" }, // same film as cast
      ],
    });
    expect(filmo.map((f) => f.id)).toEqual([10, 11]); // 2022 before 2015
    expect(filmo[0]!.role).toContain("as Hero");
    expect(filmo[0]!.role).toContain("Producer");   // cast + crew roles merged onto one row
    expect(filmo[0]!.posterUrl).toBe("https://image.tmdb.org/t/p/w185/p.jpg");
    expect(filmo[0]!.mediaType).toBe("movie");
  });
});

describe("personProfile — light path (NO image crawl)", () => {
  it("returns filmography but NO images, and touches ONLY TMDb (never wikidata/wikimedia/commons/tvdb)", async () => {
    vi.mocked(ofetch).mockClear();
    vi.mocked(ofetch).mockResolvedValueOnce({
      id: 141083, name: "Test Person", known_for_department: "Acting",
      biography: "Bio.", birthday: "1980-01-01", profile_path: "/pp.jpg",
      combined_credits: {
        cast: [{ id: 10, title: "A Film", release_date: "2020-01-01", media_type: "movie", character: "Hero", poster_path: "/p.jpg", popularity: 9 }],
        crew: [],
      },
      external_ids: { imdb_id: "nm0000001", wikidata_id: "Q42" },
    });

    const prof = await personProfile(141083);

    // (i) light shape: filmography present, image keys absent.
    expect(Array.isArray(prof.filmography)).toBe(true);
    expect(prof.filmography.length).toBe(1);
    expect("images" in prof).toBe(false);
    expect("imageSources" in prof).toBe(false);
    expect("imageStats" in prof).toBe(false);

    // (ii) exactly one HTTP call, to TMDb only — the image-source hosts are never hit.
    const urls = vi.mocked(ofetch).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("api.themoviedb.org");
    expect(urls.some((u) => /wikidata\.org|wikimedia\.org|commons|thetvdb\.com/i.test(u))).toBe(false);
  });
});

describe("watch-providers mapping (mocked network)", () => {
  it("maps TMDb watch/providers into per-country flatrate/rent/buy", async () => {
    vi.mocked(ofetch).mockResolvedValueOnce({
      id: 1,
      results: {
        IN: { link: "https://justwatch.com/in", flatrate: [{ provider_name: "Netflix", display_priority: 1, logo_path: "/n.jpg" }], rent: [{ provider_name: "Apple TV", display_priority: 2 }] },
      },
    });
    const p = await movieProviders(1, "IN");
    expect(Object.keys(p.countries)).toContain("IN");
    expect(p.countries["IN"]!.flatrate.map((x) => x.name)).toEqual(["Netflix"]);
    expect(p.countries["IN"]!.flatrate[0]!.logoUrl).toBe("https://image.tmdb.org/t/p/w92/n.jpg");
    expect(p.countries["IN"]!.rent.map((x) => x.name)).toEqual(["Apple TV"]);
  });
});

describe("person-image sources (Wikidata/Commons/Wikipedia/TVDB)", () => {
  it("Wikidata is graceful-empty when the person can't be resolved (no ids)", async () => {
    expect(await wikidataSource.getPersonImages({ tmdbId: 1 })).toEqual({ items: [] });
  });
  it("Wikipedia is graceful-empty with no name", async () => {
    expect(await wikipediaPersonSource.getPersonImages({ tmdbId: 1 })).toEqual({ items: [] });
  });
  it("TVDB person is graceful-empty with no name / no key", async () => {
    expect(await tvdbSource.getPersonImages({ tmdbId: 1 })).toEqual({ items: [] });
  });
  it("extractWikidataImages reads P18 filenames; extractCommonsCategory reads P373", () => {
    const entity = { claims: { P18: [{ mainsnak: { datavalue: { value: "Sneha.jpg" } } }], P373: [{ mainsnak: { datavalue: { value: "Sneha (actress)" } } }] } };
    expect(extractWikidataImages(entity)).toEqual(["Sneha.jpg"]);
    expect(extractCommonsCategory(entity)).toBe("Sneha (actress)");
    expect(extractWikidataImages({})).toEqual([]);
    expect(extractCommonsCategory(null)).toBeUndefined();
  });
  it("Wikipedia adapter tags source='wikipedia' and confidence-guards the name", async () => {
    // Matching title → image attached, tagged wikipedia.
    vi.mocked(ofetch).mockResolvedValueOnce({
      type: "standard", title: "Sneha",
      originalimage: { source: "https://upload.wikimedia.org/sneha.jpg", width: 800, height: 1200 },
      thumbnail: { source: "https://upload.wikimedia.org/sneha_thumb.jpg" },
    });
    const ok = await wikipediaPersonSource.getPersonImages({ tmdbId: 1, name: "Sneha" });
    expect(ok.items).toHaveLength(1);
    expect(ok.items[0]!.source).toBe("wikipedia");
    expect(ok.items[0]!.fullUrl).toBe("https://upload.wikimedia.org/sneha.jpg");

    // Wrong-person title → guarded out (no image attached).
    vi.mocked(ofetch).mockResolvedValueOnce({
      type: "standard", title: "Completely Different Person",
      originalimage: { source: "https://upload.wikimedia.org/other.jpg" },
    });
    const wrong = await wikipediaPersonSource.getPersonImages({ tmdbId: 1, name: "Sneha" });
    expect(wrong.items).toEqual([]);
  });
  it("dedupe across sources keeps one per URL and preserves source tags", () => {
    const items: ImageItem[] = [
      { source: "tmdb", kind: "profile", fullUrl: "u1", thumbUrl: "t1" },
      { source: "wikidata", kind: "profile", fullUrl: "u1", thumbUrl: "t1" }, // same URL → deduped
      { source: "wikipedia", kind: "profile", fullUrl: "u2", thumbUrl: "t2" },
      { source: "tvdb", kind: "profile", fullUrl: "u3", thumbUrl: "t3" },
    ];
    const out = dedupeImages(items);
    expect(out.map((i) => i.fullUrl)).toEqual(["u1", "u2", "u3"]);
    expect(out.map((i) => i.source)).toEqual(["tmdb", "wikipedia", "tvdb"]); // first-seen wins for u1
  });
});

describe("cinema-wide search — people + movies + series + companies", () => {
  const personSneha: MultiHit = { id: 100, media_type: "person", name: "Sneha", known_for_department: "Acting", profile_path: "/sneha.jpg", popularity: 1, known_for: [{ title: "Pattas", media_type: "movie" }] };
  const movieSneha: MultiHit = { id: 200, media_type: "movie", title: "Sneha", popularity: 6, vote_count: 300 };
  // Same name, differing department — isolates the ROLE-keyword boost.
  const rajDirector: MultiHit = { id: 300, media_type: "person", name: "Rajamouli", known_for_department: "Directing", popularity: 12 };
  const rajActor: MultiHit = { id: 301, media_type: "person", name: "Rajamouli", known_for_department: "Acting", popularity: 3 };
  const thaman: MultiHit = { id: 400, media_type: "person", name: "Thaman S", known_for_department: "Sound", popularity: 8 };
  const companyMythri: CompanyHit = { id: 500, name: "Mythri Movie Makers", origin_country: "IN" };

  it("tokenizer extracts TYPE/ROLE keywords, strips them from the name, order-independent", () => {
    const a = parseQuery("actor sneha"), b = parseQuery("sneha actor");
    expect(a.titleTokens).toEqual(["sneha"]);
    expect(a.typeBoosts).toEqual(["person"]);
    expect(a.roleDept).toBe("Acting");
    expect(a.titleTokens).toEqual(b.titleTokens);
    expect(a.typeBoosts).toEqual(b.typeBoosts);
    expect(a.roleDept).toBe(b.roleDept);
    expect(parseQuery("sneha movie").typeBoosts).toEqual(["movie"]);
    expect(parseQuery("director rajamouli").roleDept).toBe("Directing");
    expect(parseQuery("music director thaman").roleDept).toBe("Sound");   // music beats director
  });

  it("DEFAULT priority is people-first (person outranks same-name movie)", () => {
    const r = rankCandidates(parseQuery("sneha"), [movieSneha, personSneha], []);
    expect(r[0]!.type).toBe("person");
  });

  it("'actor sneha' boosts the PERSON above the same-name MOVIE (and order-independent)", () => {
    expect(rankCandidates(parseQuery("actor sneha"), [movieSneha, personSneha], [])[0]!.type).toBe("person");
    const a = rankCandidates(parseQuery("actor sneha"), [movieSneha, personSneha], []).map((x) => `${x.type}:${x.id}`);
    const b = rankCandidates(parseQuery("sneha actor"), [movieSneha, personSneha], []).map((x) => `${x.type}:${x.id}`);
    expect(a).toEqual(b);
  });

  it("'sneha movie' boosts the MOVIE to the top", () => {
    expect(rankCandidates(parseQuery("sneha movie"), [personSneha, movieSneha], [])[0]!.type).toBe("movie");
  });

  it("'director rajamouli' ranks the Directing person first (order-independent)", () => {
    const top = rankCandidates(parseQuery("director rajamouli"), [rajActor, rajDirector], [])[0]!;
    expect(top.id).toBe(300);
    expect(top.knownForDepartment).toBe("Directing");
    const a = rankCandidates(parseQuery("director rajamouli"), [rajActor, rajDirector], []).map((x) => x.id);
    const b = rankCandidates(parseQuery("rajamouli director"), [rajActor, rajDirector], []).map((x) => x.id);
    expect(a).toEqual(b);
  });

  it("'composer/music' boosts a Sound-department person", () => {
    const top = rankCandidates(parseQuery("music thaman"), [thaman], [])[0]!;
    expect(top.type).toBe("person");
    expect(top.knownForDepartment).toBe("Sound");
  });

  it("companies are included and are label-only (non-clickable)", () => {
    const r = rankCandidates(parseQuery("mythri"), [], [companyMythri]);
    const co = r.find((x) => x.type === "company");
    expect(co).toBeTruthy();
    expect(co!.title).toContain("Mythri");
    expect(co!.clickable).toBe(false);
  });

  it("back-compat: rankHits still returns mediaType for movie/tv (existing movie search)", () => {
    const r = rankHits(parseQuery("sneha"), [movieSneha]);
    expect(r[0]!.mediaType).toBe("movie");
  });
});

describe("search — people notability gate (obscure namesake vs real same-name film)", () => {
  // No profile image AND ~zero popularity ⇒ obscure.
  const obscureLenin: MultiHit = { id: 10, media_type: "person", name: "Lenin", known_for_department: "Acting", popularity: 0.5 };
  const filmLenin: MultiHit = { id: 11, media_type: "movie", title: "Lenin", original_language: "te", release_date: "2026-07-10", popularity: 15, vote_count: 40 };
  // Has an image ⇒ notable, even at low popularity.
  const notableLenin: MultiHit = { id: 12, media_type: "person", name: "Lenin", known_for_department: "Acting", profile_path: "/l.jpg", popularity: 2 };
  const popularFilm: MultiHit = { id: 13, media_type: "movie", title: "Lenin", popularity: 90, vote_count: 5000 };

  it("(i) an image-less ~zero-pop namesake ranks BELOW a real same-name film", () => {
    const r = rankCandidates(parseQuery("lenin"), [obscureLenin, filmLenin], []);
    expect(r[0]!.type).toBe("movie");
    expect(r[0]!.id).toBe(11);
  });
  it("(ii) a NOTABLE same-name person still outranks a popular film (guarantee holds)", () => {
    const r = rankCandidates(parseQuery("lenin"), [popularFilm, notableLenin], []);
    expect(r[0]!.type).toBe("person");
    expect(r[0]!.id).toBe(12);
  });
  it("(iii) an explicit TYPE keyword boosts even an obscure person above the film", () => {
    const r = rankCandidates(parseQuery("actor lenin"), [filmLenin, obscureLenin], []);
    expect(r[0]!.type).toBe("person");
    expect(r[0]!.id).toBe(10);
  });
});

describe("film-still harvesting + other-language Wikipedia (branch: more images)", () => {
  const fg = [
    { id: 1, title: "A", mediaType: "movie", role: "Actor", department: "cast", popularity: 5 },
    { id: 2, title: "B (series)", mediaType: "tv", role: "Actor", department: "cast", popularity: 100 },
    { id: 3, title: "C", mediaType: "movie", role: "Actor", department: "cast", popularity: 20 },
    { id: 4, title: "D", mediaType: "movie", role: "Actor", department: "cast", popularity: 50 },
  ] as unknown as Parameters<typeof selectStillFilms>[0];

  it("selectStillFilms takes MOVIES only, most-popular first, capped", () => {
    expect(selectStillFilms(fg, 2).map((f) => f.id)).toEqual([4, 3]);   // tv (id 2) excluded
    expect(selectStillFilms(fg, 10).map((f) => f.id)).toEqual([4, 3, 1]);
  });

  it("filmImagesToStills keeps BACKDROPS only, tags kind=still + film context, preserves source", () => {
    const imgs: ImageItem[] = [
      { source: "tmdb", kind: "poster", fullUrl: "p", thumbUrl: "p" },      // poster dropped
      { source: "tmdb", kind: "backdrop", fullUrl: "b1", thumbUrl: "b1" },
      { source: "fanart", kind: "backdrop", fullUrl: "b2", thumbUrl: "b2" },
    ];
    const stills = filmImagesToStills(imgs, "Film X");
    expect(stills.map((s) => s.fullUrl)).toEqual(["b1", "b2"]);
    expect(stills.every((s) => s.kind === "still" && s.context === "Film X")).toBe(true);
    expect(stills[0]!.source).toBe("tmdb");                                 // source label preserved
  });

  it("portraits win over stills on a shared URL (portraits merged first)", () => {
    const portraits: ImageItem[] = [{ source: "tmdb", kind: "profile", fullUrl: "u1", thumbUrl: "t" }];
    const stills: ImageItem[] = [
      { source: "fanart", kind: "still", fullUrl: "u1", thumbUrl: "t", context: "F" }, // same URL as portrait
      { source: "tmdb", kind: "still", fullUrl: "u2", thumbUrl: "t", context: "F" },
    ];
    const out = dedupeImages([...portraits, ...stills]);
    expect(out.map((i) => i.fullUrl)).toEqual(["u1", "u2"]);
    expect(out[0]!.kind).toBe("profile");                                   // u1 stays a portrait
  });

  it("other-language Wikipedia adapter is graceful-empty when the person can't be resolved", async () => {
    expect(await wikipediaLangSource.getPersonImages({ tmdbId: 1 })).toEqual({ items: [] });
  });
});

describe("keycheck status mapping (offline — MISSING vs PRESENT-but-BROKEN)", () => {
  it("SKIPPED when the env var is unset (live probe NOT called)", async () => {
    const probe = vi.fn(async () => "x");
    const r = await runCheck("Src", "NO_SUCH_KEY", probe, {});
    expect(r.status).toBe("SKIPPED");
    expect(r.detail).toContain("no NO_SUCH_KEY set");
    expect(probe).not.toHaveBeenCalled();
  });
  it("OK when the key is present and the probe resolves (evidence surfaced)", async () => {
    const r = await runCheck("Src", "K", async () => "got \"Foo\"", { K: "key-value" });
    expect(r.status).toBe("OK");
    expect(r.detail).toContain('got "Foo"');
  });
  it("FAIL when the key is PRESENT but the probe throws (a dead key must NOT pass)", async () => {
    const r = await runCheck("Src", "K", async () => { throw { status: 401, data: { status_message: "Invalid API key" } }; }, { K: "bad" });
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("K set but call failed");
    expect(r.detail).toContain("401 unauthorized");
  });
  it("FAIL surfaces 403 quota distinctly from 401", async () => {
    const r = await runCheck("Src", "K", async () => { throw { status: 403, data: { error: { message: "quotaExceeded" } } }; }, { K: "k" });
    expect(r.status).toBe("FAIL");
    expect(r.detail).toContain("403 forbidden");
  });
  it("describeError maps statuses + a network error, never echoes a key", () => {
    expect(describeError({ status: 401 })).toContain("401 unauthorized");
    expect(describeError({ status: 400, data: { error: { message: "API key not valid" } } })).toContain("400 bad request");
    expect(describeError(new Error("socket hang up"))).toContain("socket hang up");
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
