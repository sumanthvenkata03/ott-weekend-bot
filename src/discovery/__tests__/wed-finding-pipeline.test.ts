// wed-finding-pipeline.test.ts — Step 5a HEADLINE. The original problem, provably
// closed in a real-pillar shape: a Blast-like film flows the FULL Wednesday
// finding→verify pipeline — getCandidates("ott") (ottSearch → Blast; press OTT
// date survives enrich) → verifyCandidates — and comes out RENDERABLE (non-red)
// with its press June-25 date intact. Step 3's test only covered getCandidates in
// isolation; this chains it through the shared verification.
//
// REAL: getCandidates, toReleaseStub, unionFilms, enrichReleases (incl. the
// releaseDates merge), the reconcile core. Mocked: the discovery nets, the AI-OTT
// source, the verify AI-net, and the TMDb/OMDB/MDBList enrich leaves (+ config/cache).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Discovery nets empty — only the AI-OTT source supplies a film.
vi.mock("../sources/tmdbDiscover.js", () => ({ discoverTmdb: vi.fn(async () => ({ films: [], coverage: [] })), LANGUAGE_TO_TMDB: {} }));
vi.mock("../sources/wikipediaList.js", () => ({ discoverWikipedia: vi.fn(async () => ({ films: [], coverage: [] })) }));

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
// ottSearch.js exports discoverOttSearch (used by getCandidates) AND runAiNet /
// buildQueries (re-exported by reconcile/ai-net.js → used by verifyCandidates).
// Same resolved module, so this one mock covers BOTH the find and verify nets.
vi.mock("../sources/ottSearch.js", () => ({
  discoverOttSearch: vi.fn(async () => [BLAST]),
  runAiNet: vi.fn(async () => ({ films: [], rejected: [], dateConflict: [] })),
  buildQueries: vi.fn(() => []),
}));
// The OTT-calendar net is additive — mock it to [] so this Step-5a assertion stays
// scoped to the ottSearch→Blast path (and so its real fetch never fires here).
vi.mock("../sources/ottCalendar.js", () => ({ discoverOttCalendar: vi.fn(async () => []) }));

// enrich leaves — config + cache mocked so importing the ratings module never
// opens SQLite or hits config's process.exit.
vi.mock("../../shared/config.js", () => ({ config: { MDBLIST_API_KEY: "", OMDB_API_KEY: "t", TMDB_API_KEY: "t" } }));
vi.mock("../../shared/cache.js", () => ({ cached: (_k: string, l: () => unknown) => l(), db: {}, purgeExpired: vi.fn(), cacheStats: vi.fn() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({
  discoverIndianReleases: vi.fn(),
  discoverIndianOTTArrivals: vi.fn(),
  getImdbId: vi.fn(async () => "tt999"),
  getStreamingPlatforms: vi.fn(async () => ["Netflix"]),
  // The clobber scenario: TMDb returns ONLY a theatrical date for Blast.
  getCreditsAndLanguages: vi.fn(async () => ({ leadCast: ["Lead"], audioLanguages: { original: "Tamil" }, releaseDates: { theatrical: "2026-05-01" } })),
  searchTitleTmdb: vi.fn(async () => ({ movie: [], tv: [] })),
}));
vi.mock("../../ingestion/releases/omdb.js", () => ({ fetchOmdbByImdbId: vi.fn(async () => null) }));
vi.mock("../../ingestion/ratings/mdblist.js", async (orig) => {
  const real = await orig<typeof import("../../ingestion/ratings/mdblist.js")>();
  return { ...real, getMdblistRatings: vi.fn(async () => null) };
});

import { getCandidates } from "../candidates.js";
import { verifyCandidates } from "../../reconcile/verify.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { ReconcileDeps } from "../../reconcile/reconcile.js";

const OTT_WIN: BucketWindow = { start: "2026-06-22", end: "2026-06-28", dateField: "ott", label: "Now Streaming" };
const noDeps: ReconcileDeps = {
  searchTitle: async () => ({ movie: [], tv: [] }),
  fetchCredits: async () => ({ leadCast: [] }),
};

beforeEach(() => { vi.clearAllMocks(); });

describe("Wednesday finding → verify pipeline — Blast end-to-end (5a headline)", () => {
  it("🔒 Blast flows getCandidates(ott) → verifyCandidates and is RENDERABLE (non-red, ott date intact)", async () => {
    // FIND — getCandidates("ott"): ottSearch finds Blast; the press ott date
    // survives enrich (the Step-3 clobber→merge over TMDb's theatrical-only date).
    const pool = await getCandidates({ from: OTT_WIN.start, to: OTT_WIN.end, intent: "ott", languages: ["Tamil"] });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.tmdbId).toBe(55555);
    expect(pool[0]!.releaseDates?.ott).toBe("2026-06-25");

    // VERIFY — feed the found pool to the shared verification (verify AI-net empty).
    const result = await verifyCandidates(pool, { pillar: "ott", window: OTT_WIN, deps: noDeps });

    const blast = result.reconciled.find((f) => f.tmdbId === 55555);
    expect(blast).toBeDefined();
    expect(blast!.tier).not.toBe("red");                          // RENDERABLE
    expect(blast!.landingStatus).toBe("pass");                    // ott date in window
    expect(blast!.release?.releaseDates?.ott).toBe("2026-06-25"); // press date carried all the way through
  });
});
