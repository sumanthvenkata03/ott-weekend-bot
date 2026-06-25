// ott-calendar-candidates.test.ts — the OTT-CALENDAR net (V3) seen through the
// SHARED candidate surface. Proves three things end-to-end:
//   (3) a calendar-only Blast flows through getCandidates("ott") → union →
//       toReleaseStub → REAL enrichReleases and keeps releaseDates.ott = June 25.
//   (5a) Blast found by BOTH ottSearch AND ottCalendar (same id 1515729) collapses
//        to ONE renderable film whose provenance carries both sources.
//   (5b) a distinct-id same-title pair stays SPLIT at the candidate surface, and
//        unionFilms flags both possibleDistinct (Step 1 guard intact for the new net).
//
// Mocked: the algorithmic nets (so discover() is empty), BOTH OTT sources, and
// enrichReleases' TMDb/OMDB/MDBList leaves + config + cache. REAL: getCandidates,
// toReleaseStub, unionFilms, enrichReleases (incl. mergeReleaseDates).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Algorithmic nets — empty, so only the OTT sources supply films.
vi.mock("../sources/tmdbDiscover.js", () => ({
  discoverTmdb: vi.fn(async () => ({ films: [], coverage: [] })),
  LANGUAGE_TO_TMDB: {},
}));
vi.mock("../sources/wikipediaList.js", () => ({
  discoverWikipedia: vi.fn(async () => ({ films: [], coverage: [] })),
}));

// Both OTT sources are mocked at the source boundary — set per-test.
vi.mock("../sources/ottSearch.js", () => ({ discoverOttSearch: vi.fn(async () => []) }));
vi.mock("../sources/ottCalendar.js", () => ({ discoverOttCalendar: vi.fn(async () => []) }));

// enrichReleases leaves — config + cache mocked so importing the ratings module
// never opens SQLite or hits config's process.exit.
vi.mock("../../shared/config.js", () => ({
  config: { MDBLIST_API_KEY: "", OMDB_API_KEY: "test", TMDB_API_KEY: "test" },
}));
vi.mock("../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
  db: {},
  purgeExpired: vi.fn(),
  cacheStats: vi.fn(),
}));
vi.mock("../../ingestion/releases/tmdb.js", () => ({
  discoverIndianReleases: vi.fn(),
  discoverIndianOTTArrivals: vi.fn(),
  getImdbId: vi.fn(async () => "tt999"),
  getStreamingPlatforms: vi.fn(async () => ["Netflix"]),
  // TMDb returns ONLY a theatrical date for Blast — the press OTT date must survive.
  getCreditsAndLanguages: vi.fn(async () => ({
    leadCast: ["Lead"],
    audioLanguages: { original: "Tamil" },
    releaseDates: { theatrical: "2026-05-01" },
  })),
}));
vi.mock("../../ingestion/releases/omdb.js", () => ({ fetchOmdbByImdbId: vi.fn(async () => null) }));
vi.mock("../../ingestion/ratings/mdblist.js", async (orig) => {
  const real = await orig<typeof import("../../ingestion/ratings/mdblist.js")>();
  return { ...real, getMdblistRatings: vi.fn(async () => null) };
});

import { getCandidates } from "../candidates.js";
import { discoverOttSearch } from "../sources/ottSearch.js";
import { discoverOttCalendar } from "../sources/ottCalendar.js";
import { unionFilms } from "../index.js";
import { qualifyingDate, inWindow } from "../../shared/post-validator.js";
import type { DiscoveredFilm } from "../types.js";

// Blast as the CALENDAR net emits it (real id 1515729, press OTT date June 25).
function blastFrom(source: "ai-ott" | "ott-calendar", tmdbId = 1515729): DiscoveredFilm {
  return {
    title: "Blast",
    normalizedTitle: "blast",
    year: 2026,
    language: "Tamil",
    releaseDate: "2026-06-25",
    releaseType: "digital",
    tmdbId,
    ottDate: "2026-06-25",
    platform: "Netflix",
    sourceUrl: "https://www.filmibeat.com/top-listing/ott-movie-releases-this-week/",
    foundIn: [source],
    perSource: {},
  };
}

const OTT_Q = { from: "2026-06-22", to: "2026-06-28", intent: "ott" as const, languages: ["Tamil"] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discoverOttSearch).mockResolvedValue([]);
  vi.mocked(discoverOttCalendar).mockResolvedValue([]);
});

describe("getCandidates('ott') — calendar net end-to-end (the headline)", () => {
  it("🔒 a CALENDAR-only Blast emerges with its press June-25 date SURVIVING enrich", async () => {
    vi.mocked(discoverOttCalendar).mockResolvedValue([blastFrom("ott-calendar")]);

    const out = await getCandidates(OTT_Q);
    expect(out).toHaveLength(1);
    const blast = out[0]!;

    expect(blast.tmdbId).toBe(1515729);
    expect(blast.title).toBe("Blast");
    expect(blast.language).toBe("Tamil");
    expect(blast.platform).toEqual(["Netflix"]);

    // THE PROOF: the press ott date survived, alongside TMDb's theatrical date.
    expect(blast.releaseDates?.ott).toBe("2026-06-25");
    expect(blast.releaseDates?.theatrical).toBe("2026-05-01"); // merged, not clobbered

    const { date } = qualifyingDate(blast, "ott");
    expect(date).toBe("2026-06-25");
    expect(inWindow(date!, "2026-06-22", "2026-06-28")).toBe(true);
  });

  it("the calendar net was invoked for the ott window", async () => {
    await getCandidates(OTT_Q);
    expect(discoverOttCalendar).toHaveBeenCalledWith(["Tamil"], "2026-06-22", "2026-06-28");
  });

  it("ADDITIVE: a degraded ([]) calendar net leaves getCandidates(ott) unchanged (V2 level)", async () => {
    // Only ottSearch supplies Blast; the calendar net returns [] (fail-safe).
    vi.mocked(discoverOttSearch).mockResolvedValue([blastFrom("ai-ott")]);
    vi.mocked(discoverOttCalendar).mockResolvedValue([]);
    const out = await getCandidates(OTT_Q);
    expect(out).toHaveLength(1);
    expect(out[0]!.tmdbId).toBe(1515729);
  });
});

describe("getCandidates('ott') — 3-net dedup (shared-id merge, possibleDistinct intact)", () => {
  it("🔒 5a: Blast found by BOTH ottSearch AND ottCalendar (same id) → ONE film, both sources in provenance", async () => {
    vi.mocked(discoverOttSearch).mockResolvedValue([blastFrom("ai-ott")]);
    vi.mocked(discoverOttCalendar).mockResolvedValue([blastFrom("ott-calendar")]);

    const out = await getCandidates(OTT_Q);
    expect(out).toHaveLength(1);                         // shared id collapses to one
    expect(out[0]!.tmdbId).toBe(1515729);
    expect(out[0]!.sources).toEqual(expect.arrayContaining(["ai-ott", "ott-calendar"]));
  });

  it("🔒 5b: distinct-id same-title pair STAYS SPLIT at the candidate surface", async () => {
    vi.mocked(discoverOttSearch).mockResolvedValue([blastFrom("ai-ott", 1515729)]);
    vi.mocked(discoverOttCalendar).mockResolvedValue([blastFrom("ott-calendar", 9999999)]);

    const out = await getCandidates(OTT_Q);
    expect(out).toHaveLength(2);                         // different ids ⇒ never merged
    expect(out.map((r) => r.tmdbId).sort()).toEqual([1515729, 9999999]);
  });

  it("🔒 5b (flag): unionFilms flags BOTH possibleDistinct for the distinct-id pair (Step 1 guard, new net)", () => {
    const out = unionFilms([blastFrom("ai-ott", 1515729), blastFrom("ott-calendar", 9999999)]);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.possibleDistinct === true)).toBe(true);
  });
});
