// candidates.test.ts — pins the Step 2 shared surface: the DiscoveredFilm→Release
// adapter (toReleaseStub, incl. the invalid-language drop) and getCandidates'
// intent routing + language default. Both `discover` and the shared
// `enrichReleases` are mocked so this stays offline and isolated to the routing
// logic — enrichment correctness is pinned separately in src/ingestion.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED = ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi"];

vi.mock("../index.js", () => ({
  discover: vi.fn(),
  unionFilms: (films: unknown[]) => films, // not exercised here (ottSearch mocked to [])
  SUPPORTED_LANGUAGES: ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi"],
}));
// Identity enrich — keeps this test on routing/adapter only (no TMDb/OMDB/config).
vi.mock("../../ingestion/releases/index.js", () => ({
  enrichReleases: vi.fn(async (stubs: unknown) => stubs),
}));
// Mock BOTH OTT nets so they never really fire (no Tavily/Claude/HTTP/SQLite); we
// assert WHETHER they're called to prove theatrical isolation.
vi.mock("../sources/ottSearch.js", () => ({
  discoverOttSearch: vi.fn(async () => []),
}));
vi.mock("../sources/ottCalendar.js", () => ({
  discoverOttCalendar: vi.fn(async () => []),
}));
// WD-ENG-17 — the news net runs on BOTH intents, so it must be mocked here too
// or every case in this file makes 9 real RSS requests and one real LLM call.
vi.mock("../sources/newsNet.js", () => ({
  discoverNewsNet: vi.fn(async () => []),
}));

import { discover } from "../index.js";
import { enrichReleases } from "../../ingestion/releases/index.js";
import { discoverOttSearch } from "../sources/ottSearch.js";
import { discoverOttCalendar } from "../sources/ottCalendar.js";
import { discoverNewsNet } from "../sources/newsNet.js";
import { getCandidates, toReleaseStub } from "../candidates.js";
import { log } from "../../shared/logger.js";
import type { DiscoveredFilm, DiscoveryResult, ReleaseType } from "../types.js";
import type { Release } from "../../shared/types.js";

const mockDiscover = vi.mocked(discover);
const mockEnrich = vi.mocked(enrichReleases);
const mockOttSearch = vi.mocked(discoverOttSearch);
const mockOttCalendar = vi.mocked(discoverOttCalendar);
const mockNewsNet = vi.mocked(discoverNewsNet);

interface FilmSpec {
  title: string;
  language?: string;
  year?: number;
  releaseDate?: string;
  releaseType?: ReleaseType;
  tmdbId?: number;
  normalizedTitle?: string;
}

function film(p: FilmSpec): DiscoveredFilm {
  return {
    title: p.title,
    normalizedTitle: p.normalizedTitle ?? p.title.toLowerCase(),
    ...(p.year !== undefined ? { year: p.year } : {}),
    ...(p.language !== undefined ? { language: p.language } : {}),
    ...(p.releaseDate !== undefined ? { releaseDate: p.releaseDate } : {}),
    ...(p.releaseType !== undefined ? { releaseType: p.releaseType } : {}),
    ...(p.tmdbId !== undefined ? { tmdbId: p.tmdbId } : {}),
    foundIn: ["tmdb"],
    perSource: {},
  };
}

function discoveryResult(films: DiscoveredFilm[]): DiscoveryResult {
  return {
    query: { from: "2026-01-01", to: "2026-01-31", languages: SUPPORTED },
    films,
    stats: { perNet: { tmdb: films.length, wikipedia: 0 }, unionCount: films.length, onlyInTmdb: films.length, onlyInWikipedia: 0, inBoth: 0 },
    ranAt: "2026-01-01T00:00:00.000Z",
    // WD-ENG-07 — these fixtures are TMDb-only, so the wiki index is empty. An
    // empty index is the "behaviour identical to before" path.
    wikiLanguageIndex: new Map<string, string>(),
  };
}

/** tmdbIds of the stubs handed to the (mocked) enrichReleases, sorted. */
function enrichedIds(): number[] {
  const stubs = mockEnrich.mock.calls[0]?.[0] as Release[] | undefined;
  return (stubs ?? []).map((s) => s.tmdbId).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnrich.mockImplementation(async (stubs) => stubs);
  mockOttSearch.mockResolvedValue([]);
  mockOttCalendar.mockResolvedValue([]);
});

describe("toReleaseStub — DiscoveredFilm → Release adapter", () => {
  it("valid language string → correct Language enum + identity/provenance fields", () => {
    const out = toReleaseStub(film({ title: "Mathru", language: "Telugu", tmdbId: 5, releaseDate: "2026-02-05", releaseType: "digital" }));
    expect(out).toBeDefined();
    expect(out!.language).toBe("Telugu");
    expect(out!.tmdbId).toBe(5);
    expect(out!.id).toBe("tmdb-5");
    expect(out!.title).toBe("Mathru");
    expect(out!.releaseDate).toBe("2026-02-05");
    expect(out!.sources).toEqual(["tmdb"]);
    expect(out!.platform).toEqual([]);
    // tmdbPopularity omitted on purpose — the signal enrich uses to backfill.
    expect(out!.tmdbPopularity).toBeUndefined();
  });

  it("🔒 INVALID language string → dropped (undefined) + warn, never coerced or crashed", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const out = toReleaseStub(film({ title: "Mystery", language: "Klingon", tmdbId: 6, releaseType: "theatrical" }));
    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropping "Mystery" — unrecognized language "Klingon"/));
  });

  it("🔒 'Other' / missing language → dropped (not mapped to a wrong language)", () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(toReleaseStub(film({ title: "A", language: "Other", tmdbId: 7, releaseType: "theatrical" }))).toBeUndefined();
    expect(toReleaseStub(film({ title: "B", tmdbId: 8, releaseType: "theatrical" }))).toBeUndefined();
  });
});

describe("getCandidates — intent routing onto discovery releaseType", () => {
  const mixed = [
    film({ title: "TheatricalOne", language: "Telugu", tmdbId: 1, releaseType: "theatrical" }),
    film({ title: "DigitalTwo", language: "Telugu", tmdbId: 2, releaseType: "digital" }),
    film({ title: "BothThree", language: "Kannada", tmdbId: 3, releaseType: "both" }),
    film({ title: "WikiOnly", language: "Telugu", tmdbId: 99 }), // no releaseType → excluded
  ];

  it("intent 'theatrical' → theatrical + both (NOT digital, NOT wiki-only)", async () => {
    mockDiscover.mockResolvedValue(discoveryResult(mixed));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    expect(mockEnrich).toHaveBeenCalledTimes(1);
    expect(enrichedIds()).toEqual([1, 3]);
  });

  it("intent 'ott' → digital + both (NOT theatrical, NOT wiki-only)", async () => {
    mockDiscover.mockResolvedValue(discoveryResult(mixed));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "ott" });
    expect(enrichedIds()).toEqual([2, 3]);
  });

  it("an invalid-language find is dropped even when its intent matches", async () => {
    vi.spyOn(log, "warn").mockImplementation(() => {});
    mockDiscover.mockResolvedValue(discoveryResult([
      film({ title: "Good", language: "Telugu", tmdbId: 10, releaseType: "theatrical" }),
      film({ title: "Bad", language: "Klingon", tmdbId: 11, releaseType: "theatrical" }),
    ]));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    expect(enrichedIds()).toEqual([10]); // 11 dropped by the adapter
  });

  it("returns the enrichReleases output as the result (Release[] with the language enum mapped)", async () => {
    mockDiscover.mockResolvedValue(discoveryResult([film({ title: "Solo", language: "Telugu", tmdbId: 1, releaseType: "theatrical" })]));
    const { releases: out } = await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    expect(out).toHaveLength(1);
    expect(out[0]!.language).toBe("Telugu");
    expect(out[0]!.tmdbId).toBe(1);
  });
});

describe("getCandidates — OTT-net intent gating (theatrical isolation)", () => {
  it("🔒 intent 'theatrical' triggers NO recall net (0 LLM — the 4 theatrical pillars are free)", async () => {
    mockDiscover.mockResolvedValue(discoveryResult([
      film({ title: "T", language: "Telugu", tmdbId: 1, releaseType: "theatrical" }),
    ]));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    expect(mockOttSearch).not.toHaveBeenCalled();
    expect(mockOttCalendar).not.toHaveBeenCalled();
    // WD-ENG-17D — the news net is back on this side of the line too. It shipped
    // on BOTH intents in WD-ENG-17 and was gated to OTT on measurement, not
    // principle: WD-ENG-17C spent one billed theatrical extraction over 178 real
    // headlines and got 2 candidates, both ALREADY green via TMDb, one of them
    // (Batwara 1947) carrying a wrong date off a shared roundup headline. Zero
    // new films for one billed call per theatrical pillar run.
    expect(mockNewsNet).not.toHaveBeenCalled();
  });

  it("🔒 ZERO ANTHROPIC CALLS on the theatrical path — the property, stated as a whole", async () => {
    // Mon Movement, Sat Verdict, Sun Spotlight and Fri Archives all reach
    // discovery through getCandidates(theatrical). Every net that can bill an
    // extraction is asserted absent here, together, so a future net wired
    // "just for theatrical" trips this instead of appearing on a bill.
    mockDiscover.mockResolvedValue(discoveryResult([]));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    for (const [name, m] of [
      ["ottSearch", mockOttSearch],
      ["ottCalendar", mockOttCalendar],
      ["newsNet", mockNewsNet],
    ] as const) {
      expect(m, `${name} must not run on the theatrical intent`).not.toHaveBeenCalled();
    }
  });

  it("the two films theatrical was wired FOR are not reachable that way — recorded, not retried", () => {
    // Chargesheet 03-08 and Panchali Panchabhartruka were the whole argument for
    // the theatrical half. WD-ENG-17C showed the extractor correctly REJECTS
    // both — their only headlines are a box-office collection story and a
    // pre-release event, neither of which is a dated release announcement.
    // Recorded in the source so the next person does not re-wire it and re-spend
    // the measurement.
    const src = readFileSync(join(process.cwd(), "src/discovery/candidates.ts"), "utf8");
    expect(src).toContain("WD-ENG-17C");
    expect(src).toContain("Chargesheet 03-08");
    expect(src).toContain("Panchali Panchabhartruka");
    expect(src).toContain("box-office and event reporting, not");
    expect(src).toContain("dated release announcements");
  });

  it("intent 'ott' DOES trigger BOTH OTT nets (Blast-recall path), once each, with the same window/languages", async () => {
    mockDiscover.mockResolvedValue(discoveryResult([]));
    await getCandidates({ from: "2026-06-22", to: "2026-06-28", intent: "ott", languages: ["Tamil"] });
    expect(mockOttSearch).toHaveBeenCalledTimes(1);
    expect(mockOttSearch).toHaveBeenCalledWith(["Tamil"], "2026-06-22", "2026-06-28");
    expect(mockOttCalendar).toHaveBeenCalledTimes(1);
    expect(mockOttCalendar).toHaveBeenCalledWith(["Tamil"], "2026-06-22", "2026-06-28");
    // …and the news net rides alongside them — OTT ONLY, and still exactly once.
    // The OTT half is what WD-ENG-17B measured at 6 candidates / zero false
    // positives / Mr. Work From Home recovered, and WD-ENG-17D left it untouched.
    expect(mockNewsNet).toHaveBeenCalledTimes(1);
    expect(mockNewsNet).toHaveBeenCalledWith("ott", "2026-06-22", "2026-06-28");
  });
});

describe("getCandidates — language defaulting", () => {
  it("no languages → defaults to all 7 supported (Bengali trimmed; Marathi + Punjabi stay)", async () => {
    mockDiscover.mockResolvedValue(discoveryResult([]));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "theatrical" });
    const arg = mockDiscover.mock.calls[0]![0];
    expect(arg.languages).toHaveLength(7);
    expect(arg.languages).toContain("Punjabi");
    expect(arg.languages).not.toContain("Bengali");
  });

  it("explicit languages are passed through to discover", async () => {
    mockDiscover.mockResolvedValue(discoveryResult([]));
    await getCandidates({ from: "2026-01-01", to: "2026-01-31", intent: "ott", languages: ["Telugu"] });
    expect(mockDiscover.mock.calls[0]![0].languages).toEqual(["Telugu"]);
  });
});
