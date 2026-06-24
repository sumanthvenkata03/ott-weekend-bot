// enrich.test.ts — pins the Step 2 enrichment refactor:
//   1. enrichReleases() fills a lean discovery stub (incl. tmdbPopularity, which
//      the select.ts cap depends on, + poster/synopsis/genre via the widened
//      /movie/{id} backfill, + ratings).
//   2. ingestReleases / ingestOTTArrivals REGRESSION — they now call
//      enrichReleases internally and must still produce identical output: an old
//      discover-row already carries tmdbPopularity, so the backfill is a NO-OP
//      and its discover-row fields are preserved byte-for-byte.
//
// All TMDb/OMDB network fns are mocked; config + cache are mocked so importing
// the ratings module (kept real, for mergeRatings/computeTbsiScore) never opens
// SQLite or hits config's process.exit. mdblist returns null → OMDb path drives.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../shared/config.js", () => ({
  config: { MDBLIST_API_KEY: "", OMDB_API_KEY: "test", TMDB_API_KEY: "test" },
}));
vi.mock("../../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
  db: {},
  purgeExpired: vi.fn(),
  cacheStats: vi.fn(),
}));
// tmdb.js — mock ONLY the 5 fns index.ts imports (no importActual → no SQLite).
vi.mock("../tmdb.js", () => ({
  discoverIndianReleases: vi.fn(),
  discoverIndianOTTArrivals: vi.fn(),
  getImdbId: vi.fn(),
  getStreamingPlatforms: vi.fn(),
  getCreditsAndLanguages: vi.fn(),
}));
vi.mock("../omdb.js", () => ({ fetchOmdbByImdbId: vi.fn() }));
// Keep mergeRatings + computeTbsiScore REAL; stub only the network fetch.
vi.mock("../../ratings/mdblist.js", async (orig) => {
  const real = await orig<typeof import("../../ratings/mdblist.js")>();
  return { ...real, getMdblistRatings: vi.fn() };
});

import {
  discoverIndianReleases,
  discoverIndianOTTArrivals,
  getImdbId,
  getStreamingPlatforms,
  getCreditsAndLanguages,
} from "../tmdb.js";
import { fetchOmdbByImdbId } from "../omdb.js";
import { getMdblistRatings } from "../../ratings/mdblist.js";
import { enrichReleases, ingestReleases, ingestOTTArrivals } from "../index.js";
import type { Release } from "../../../shared/types.js";

const credits = {
  leadCast: ["Lead A", "Lead B"],
  musicDirector: "Composer C",
  audioLanguages: { original: "Telugu" },
  releaseDates: { ott: "2026-02-05" },
  // Step 2 backfill payload (from the widened /movie/{id} response):
  posterUrl: "https://image.tmdb.org/t/p/w500/p.jpg",
  synopsis: "A backfilled synopsis.",
  genre: ["Drama", "Thriller"],
  tmdbPopularity: 42.5,
  tmdbVoteAverage: 7.2,
  tmdbVoteCount: 150,
};

const omdb = {
  imdbId: "tt123",
  imdbRating: 7.5,
  imdbVotes: 1200,
  rottenTomatoes: 88,
  metacritic: 70,
  director: "Dir D",
  cast: ["Actor X", "Actor Y", "Actor Z"],
  runtime: 130,
  languages: ["Telugu", "Tamil"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getImdbId).mockResolvedValue("tt123");
  vi.mocked(getStreamingPlatforms).mockResolvedValue(["Netflix"]);
  vi.mocked(getCreditsAndLanguages).mockResolvedValue(credits);
  vi.mocked(fetchOmdbByImdbId).mockResolvedValue(omdb);
  vi.mocked(getMdblistRatings).mockResolvedValue(null);
});

function leanStub(over: Partial<Release> = {}): Release {
  return {
    id: "tmdb-1",
    tmdbId: 1,
    title: "Stub Film",
    language: "Telugu",
    isSeries: false,
    platform: [],
    releaseDate: "2026-02-05",
    genre: [],
    cast: [],
    synopsis: "",
    subtitleLanguages: [],
    sources: ["tmdb"],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("enrichReleases — lean discovery stub gets fully enriched", () => {
  it("🔒 backfills tmdbPopularity (the select.ts cap depends on it) + poster/synopsis/genre", async () => {
    const [out] = await enrichReleases([leanStub()]);
    expect(out!.tmdbPopularity).toBe(42.5); // ← the cap-ranking field
    expect(out!.posterUrl).toBe("https://image.tmdb.org/t/p/w500/p.jpg");
    expect(out!.synopsis).toBe("A backfilled synopsis.");
    expect(out!.genre).toEqual(["Drama", "Thriller"]);
    expect(out!.tmdbVoteAverage).toBe(7.2);
    expect(out!.tmdbVoteCount).toBe(150);
  });

  it("applies the full chain: IMDb id, platforms, credits/audio, releaseDates, ratings", async () => {
    const [out] = await enrichReleases([leanStub()]);
    expect(out!.imdbId).toBe("tt123");
    expect(out!.platform).toEqual(["Netflix"]);
    expect(out!.leadCast).toEqual(["Lead A", "Lead B"]);
    expect(out!.musicDirector).toBe("Composer C");
    expect(out!.releaseDates).toEqual({ ott: "2026-02-05" });
    expect(out!.imdbRating).toBe(7.5);
    expect(out!.cast).toEqual(["Actor X", "Actor Y", "Actor Z"]); // OMDb fills empty cast
    expect(out!.tbsiScore).toBeGreaterThan(0); // computeTbsiScore is REAL
    expect(out!.sources).toEqual(expect.arrayContaining(["tmdb", "omdb"]));
  });

  it("empty input short-circuits", async () => {
    expect(await enrichReleases([])).toEqual([]);
  });
});

describe("ingestReleases — REGRESSION: still identical output after the refactor", () => {
  // An old discover row already carries tmdbPopularity (+ poster/synopsis/genre),
  // so the Step 2 backfill is a NO-OP — those discover-row fields must survive.
  const oldRow = (): Release => leanStub({
    title: "Old Film",
    genre: ["Action"],
    synopsis: "Old synopsis",
    posterUrl: "https://old/poster.jpg",
    tmdbPopularity: 99,
    tmdbVoteAverage: 6.1,
    tmdbVoteCount: 50,
  });

  it("🔒 discover-row fields are preserved (backfill skipped because tmdbPopularity is set)", async () => {
    vi.mocked(discoverIndianReleases).mockResolvedValue([oldRow()]);
    const [out] = await ingestReleases("2026-01-01", "2026-12-31");
    expect(out!.tmdbPopularity).toBe(99);            // NOT overwritten by 42.5
    expect(out!.tmdbVoteAverage).toBe(6.1);
    expect(out!.tmdbVoteCount).toBe(50);
    expect(out!.genre).toEqual(["Action"]);          // NOT overwritten by credits genre
    expect(out!.posterUrl).toBe("https://old/poster.jpg");
    expect(out!.synopsis).toBe("Old synopsis");
  });

  it("enrichment is still applied (IMDb / platforms / ratings / credits)", async () => {
    vi.mocked(discoverIndianReleases).mockResolvedValue([oldRow()]);
    const [out] = await ingestReleases("2026-01-01", "2026-12-31");
    expect(out!.imdbId).toBe("tt123");
    expect(out!.platform).toEqual(["Netflix"]);
    expect(out!.imdbRating).toBe(7.5);
    expect(out!.leadCast).toEqual(["Lead A", "Lead B"]);
  });

  it("empty discover → [] (early return, no enrichment calls)", async () => {
    vi.mocked(discoverIndianReleases).mockResolvedValue([]);
    expect(await ingestReleases("2026-01-01", "2026-12-31")).toEqual([]);
    expect(getImdbId).not.toHaveBeenCalled();
  });
});

describe("ingestOTTArrivals — REGRESSION: enriches via the same seam", () => {
  it("runs the shared enrichment and preserves the OTT discover-row popularity", async () => {
    vi.mocked(discoverIndianOTTArrivals).mockResolvedValue([
      leanStub({ title: "OTT Film", sources: ["tmdb-ott"], tmdbPopularity: 80 }),
    ]);
    const [out] = await ingestOTTArrivals("2026-01-01", "2026-12-31");
    expect(out!.tmdbPopularity).toBe(80); // unchanged
    expect(out!.imdbId).toBe("tt123");
    expect(out!.platform).toEqual(["Netflix"]);
    expect(out!.imdbRating).toBe(7.5);
  });
});
