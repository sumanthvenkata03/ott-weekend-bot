// ott-candidates.test.ts — THE HEADLINE PROOF. A Blast-like AI-OTT find flows
// end-to-end through getCandidates("ott"): union → toReleaseStub → REAL
// enrichReleases, and the resulting Release keeps releaseDates.ott = June 25
// EVEN THOUGH TMDb's /movie/{id} returns only a May theatrical date. This proves
// the clobber→merge fix: without it, TMDb's {theatrical} would stomp the press
// {ott} during enrich and the landing verifier would never see June 25.
//
// Mocked: the discovery nets (so discover() is empty), the AI-OTT source (so it
// returns Blast with no Tavily/Claude), and enrichReleases' TMDb/OMDB/MDBList
// leaves + config + cache. REAL: getCandidates, toReleaseStub, unionFilms,
// enrichReleases (incl. mergeReleaseDates), and the post-validator date check.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Discovery nets — empty, so only the AI-OTT source supplies a film.
vi.mock("../sources/tmdbDiscover.js", () => ({
  discoverTmdb: vi.fn(async () => ({ films: [], coverage: [] })),
  LANGUAGE_TO_TMDB: {},
}));
vi.mock("../sources/wikipediaList.js", () => ({
  discoverWikipedia: vi.fn(async () => ({ films: [], coverage: [] })),
}));

// AI-OTT source → one Blast find (press OTT date June 25, theatrical-in-TMDb May).
const BLAST = {
  title: "Blast",
  normalizedTitle: "blast",
  year: 2026,
  language: "Tamil",
  releaseDate: "2026-06-25",
  releaseType: "digital" as const,
  tmdbId: 55555,
  ottDate: "2026-06-25",
  platform: "Netflix",
  sourceUrl: "https://news.example/blast",
  foundIn: ["ai-ott" as const],
  perSource: {},
};
vi.mock("../sources/ottSearch.js", () => ({
  discoverOttSearch: vi.fn(async () => [BLAST]),
}));
// The OTT-calendar net is additive — mock it to [] so this test stays scoped to
// the ottSearch→Blast path (and its real fetch never fires here).
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
  // The clobber scenario: TMDb returns ONLY a theatrical date for Blast.
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
import { qualifyingDate, inWindow } from "../../shared/post-validator.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(discoverOttSearch).mockResolvedValue([BLAST]);
});

describe("getCandidates('ott') — Blast end-to-end (the headline)", () => {
  it("🔒 Blast emerges with its press June-25 date in releaseDates.ott SURVIVING enrich", async () => {
    const out = await getCandidates({ from: "2026-06-22", to: "2026-06-28", intent: "ott", languages: ["Tamil"] });

    expect(out).toHaveLength(1);
    const blast = out[0]!;

    // Resolved to its real TMDb id, with the press platform mapped to the enum.
    expect(blast.tmdbId).toBe(55555);
    expect(blast.title).toBe("Blast");
    expect(blast.language).toBe("Tamil");
    expect(blast.platform).toEqual(["Netflix"]);

    // THE PROOF: the press ott date survived, alongside TMDb's theatrical date.
    expect(blast.releaseDates?.ott).toBe("2026-06-25");
    expect(blast.releaseDates?.theatrical).toBe("2026-05-01"); // merged, not clobbered

    // The landing verifier reads releaseDates.ott for dateField "ott" → in-window.
    const { date } = qualifyingDate(blast, "ott");
    expect(date).toBe("2026-06-25");
    expect(inWindow(date!, "2026-06-22", "2026-06-28")).toBe(true);

    // Enrichment still ran (IMDb id resolved).
    expect(blast.imdbId).toBe("tt999");
  });

  it("the AI OTT search was invoked for the ott window", async () => {
    await getCandidates({ from: "2026-06-22", to: "2026-06-28", intent: "ott", languages: ["Tamil"] });
    expect(discoverOttSearch).toHaveBeenCalledWith(["Tamil"], "2026-06-22", "2026-06-28");
  });
});
