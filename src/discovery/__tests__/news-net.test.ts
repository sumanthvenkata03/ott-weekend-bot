// WD-ENG-17 — THE NEWS NET, driven off REAL captured Google News RSS.
//
// ── WHY THIS NET EXISTS ─────────────────────────────────────────────────────
// The WD-ENG-15 survey probed the whole candidate space with the project UA.
// Google News RSS was the ONLY source carrying all five of that week's missed
// films — Mr. Work From Home, Nijame Rujuvainadhi, Kattalan, Chargesheet 03-08,
// Panchali Panchabhartruka — four of which have no TMDb record at all. It was
// already in the codebase as the news desk's transport and had never been wired
// to discovery. The gap was wiring.
//
// FIXTURES are real captured feeds (src/discovery/__tests__/fixtures/gnews/),
// so the parse path is exercised against Google's actual XML rather than a
// hand-written idealisation. The LLM and TMDb are mocked: no network, no cost.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));
vi.mock("../../research/http.js", () => ({ fetchCached: vi.fn() }));
vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({ searchTitleTmdb: vi.fn() }));

// The streak ledger is stubbed in memory (WD-ENG-13 precedent): the real one
// writes data/source-health.json, and a test has no business mutating it.
const healthStub = vi.hoisted(() => ({ failures: 0 }));
vi.mock("../sources/source-health.js", async (orig) => {
  const real = await orig<typeof import("../sources/source-health.js")>();
  return {
    ...real,
    recordSourceFailure: vi.fn(() => ({
      consecutiveFailures: ++healthStub.failures,
      firstFailureAt: "2026-08-01T00:00:00.000Z",
      lastSuccessAt: null,
    })),
    recordSourceSuccess: vi.fn(() => ({
      consecutiveFailures: healthStub.failures,
      firstFailureAt: null,
      lastSuccessAt: null,
    })),
  };
});

import { fetchCached } from "../../research/http.js";
import { callClaudeJSON } from "../../content/claude.js";
import { searchTitleTmdb } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";
import {
  discoverNewsNet,
  buildNewsQueries,
  buildNewsPrompt,
  newsFeedUrl,
  humanDate,
  hasUsableDate,
} from "../sources/newsNet.js";
import { loadGnewsXml } from "./helpers/load.js";

const mockFetch = vi.mocked(fetchCached);
const mockClaude = vi.mocked(callClaudeJSON);
const mockSearch = vi.mocked(searchTitleTmdb);

const FROM = "2026-08-10";
const TO = "2026-08-16";

// Real captured feeds for the Aug 10-16 window.
const OTT_TE = loadGnewsXml("ott-telugu.xml");
const THE_TE = loadGnewsXml("theatrical-telugu.xml");
const DATED = loadGnewsXml("dated-aug14.xml");
const THE_KN = loadGnewsXml("theatrical-kannada.xml");

const film = (over: Record<string, unknown>) => ({
  title: "X", isSeries: false, sources: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  healthStub.failures = 0;
  mockFetch.mockResolvedValue({ value: DATED, cached: false } as never);
  mockClaude.mockResolvedValue({ films: [], rejected: [] } as never);
  mockSearch.mockResolvedValue({ movie: [], tv: [] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe("the query set is release-calendar-shaped, not news-shaped", () => {
  it("covers all seven pillar languages plus window-date anchors", () => {
    const q = buildNewsQueries("ott", FROM, TO);
    for (const L of ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi"]) {
      expect(q.some((x) => x.language === L), L).toBe(true);
    }
    // The two dated anchors are what caught Chargesheet 03-08 and Nijame
    // Rujuvainadhi, which the per-language queries alone missed (WD-ENG-17 1b).
    const dated = q.filter((x) => x.language === undefined);
    expect(dated).toHaveLength(2);
    expect(dated.map((d) => d.query).join(" ")).toContain("August 10 2026");
    expect(dated.map((d) => d.query).join(" ")).toContain("August 16 2026");
  });

  it("REQUEST BUDGET — 9 RSS requests per run, and that is the whole cost", () => {
    // Free, keyless, cached 6h. This pin exists so a future query-set expansion
    // is a deliberate act rather than a quota surprise.
    expect(buildNewsQueries("ott", FROM, TO)).toHaveLength(9);
    expect(buildNewsQueries("theatrical", FROM, TO)).toHaveLength(9);
  });

  it("date anchors are prose, because Google News does not read ISO", () => {
    expect(humanDate("2026-08-14")).toBe("August 14 2026");
    expect(humanDate("not-a-date")).toBe("not-a-date");
  });

  it("the feed URL keeps the India edition and a 7-day recency bound", () => {
    const u = newsFeedUrl("Telugu OTT release");
    expect(u).toContain("news.google.com/rss/search");
    expect(u).toContain("hl=en-IN&gl=IN&ceid=IN:en");
    expect(decodeURIComponent(u)).toContain("when:7d");
  });

  it("a single query collapses to one intent's set — theatrical differs from ott", () => {
    const ott = buildNewsQueries("ott", FROM, TO).map((q) => q.query).join("|");
    const th = buildNewsQueries("theatrical", FROM, TO).map((q) => q.query).join("|");
    expect(ott).not.toBe(th);
    expect(ott).toContain("OTT release this week streaming premiere");
    expect(th).toContain("theatrical release this week in cinemas");
  });
});

describe("the REAL captured feeds carry the films WD-ENG-15 said they carry", () => {
  // Fixture-level proof, independent of the extractor: if these regress, the
  // net's premise is gone and the tests below would be testing a mock.
  it.each([
    ["Mr. Work From Home", /work\s*from\s*home/i, OTT_TE],
    ["Kattalan", /kattalan/i, OTT_TE],
    ["Panchali Panchabhartruka", /panchali|panchabhart/i, THE_TE],
    ["Nijame Rujuvainadhi", /nijame|rujuvain/i, DATED],
    ["Chargesheet 03-08", /charge\s*sheet/i, DATED],
  ])("%s is present in a captured feed", (_label, re, xml) => {
    expect(re.test(xml)).toBe(true);
  });

  it("WHY BOTH QUERY SHAPES ARE REQUIRED — the per-language feed alone misses two", () => {
    // Chargesheet 03-08 and Nijame Rujuvainadhi are NOT in the per-language
    // feeds. They are only in the window-date-anchored one. This is the pin for
    // the WD-ENG-17 1b finding that the per-language set caught 3 of 5 and the
    // dated anchors supplied the rest — dropping either shape reopens a hole.
    expect(/charge\s*sheet/i.test(THE_KN)).toBe(false);
    expect(/charge\s*sheet/i.test(THE_TE)).toBe(false);
    expect(/nijame|rujuvain/i.test(OTT_TE)).toBe(false);
    // …and both are in the dated feed.
    expect(/charge\s*sheet/i.test(DATED)).toBe(true);
    expect(/nijame|rujuvain/i.test(DATED)).toBe(true);
  });
});

describe("headlines reach the extractor, parsed by the news desk's own parser", () => {
  it("real RSS is parsed and the outlet suffix is stripped before extraction", async () => {
    mockFetch.mockResolvedValue({ value: OTT_TE, cached: false } as never);
    await discoverNewsNet("ott", FROM, TO);

    expect(mockClaude).toHaveBeenCalledTimes(1);          // ONE extraction per run
    const prompt = String(mockClaude.mock.calls[0]![0]);
    expect(prompt).toContain("HEADLINES (the ONLY ground truth)");
    // Google News appends " - Outlet"; the reused stripOutletSuffix removes it.
    expect(prompt).not.toMatch(/ - Esquire India\n/);
  });

  it("EXACTLY ONE LLM call per run regardless of how many queries ran", async () => {
    await discoverNewsNet("theatrical", FROM, TO);
    expect(mockFetch).toHaveBeenCalledTimes(9);
    expect(mockClaude).toHaveBeenCalledTimes(1);
  });
});

describe("PART 3 — the extractor may not manufacture confidence", () => {
  const resolves = () =>
    mockSearch.mockResolvedValue({
      movie: [{ id: 77, title: "Kattalan", year: 2026, originalLanguage: "ml", releaseDate: "2026-08-13" }],
      tv: [],
    } as never);

  it("A DATELESS HEADLINE PRODUCES NO DATED CANDIDATE — the rule, in code", async () => {
    resolves();
    // The extractor returns a film with no date at all.
    mockClaude.mockResolvedValue({ films: [film({ title: "Kattalan" })], rejected: [] } as never);

    const out = await discoverNewsNet("ott", FROM, TO);

    expect(out).toEqual([]);           // dropped, not dated from the window
    expect(mockSearch).not.toHaveBeenCalled();   // not even resolved
  });

  it("the guard is code, not just prompt text", () => {
    // WD-ENG-12 catalogued 19 editorial rules that lived only in prompt text and
    // bound nothing. This one has both halves.
    expect(hasUsableDate(film({ date: "2026-08-14" }) as never)).toBe(true);
    expect(hasUsableDate(film({}) as never)).toBe(false);
    expect(hasUsableDate(film({ date: "next Friday" }) as never)).toBe(false);
    expect(hasUsableDate(film({ date: "2026-08" }) as never)).toBe(false);
  });

  it("the prompt states the no-manufactured-date rule explicitly", () => {
    const p = buildNewsPrompt("ott", FROM, TO, ["a headline"]);
    expect(p).toContain("NEVER MANUFACTURE A DATE");
    expect(p).toContain("must NOT get a date");
    expect(p).toMatch(/TEASER, TRAILER, poster, press meet, casting, box office, review, delay/);
  });

  it("a dated film DOES become a candidate — the guard is not a blanket refusal", async () => {
    resolves();
    mockClaude.mockResolvedValue({
      films: [film({ title: "Kattalan", language: "Malayalam", platform: "ManoramaMAX", date: "2026-08-13" })],
      rejected: [],
    } as never);

    const out = await discoverNewsNet("ott", FROM, TO);

    expect(out).toHaveLength(1);
    expect(out[0]!.tmdbId).toBe(77);
    expect(out[0]!.releaseType).toBe("digital");
    expect(out[0]!.ottDate).toBe("2026-08-13");
    expect(out[0]!.platform).toBe("ManoramaMAX");
    expect(out[0]!.foundIn).toEqual(["news"]);   // its OWN provenance
  });

  it("a non-film headline produces no candidate — series are dropped", async () => {
    mockClaude.mockResolvedValue({
      films: [film({ title: "Some Show S2", isSeries: true, date: "2026-08-14" })],
      rejected: [{ title: "Some Show S2", reason: "series" }],
    } as never);
    // isSeries short-circuits the TMDb search to an empty result set.
    const out = await discoverNewsNet("ott", FROM, TO);
    expect(out).toEqual([]);
  });

  it("a NON-INDIAN resolved language is dropped (the shared Indian guard)", async () => {
    mockSearch.mockResolvedValue({
      movie: [{ id: 9, title: "Foreign", year: 2026, originalLanguage: "en", releaseDate: "2026-08-13" }],
      tv: [],
    } as never);
    mockClaude.mockResolvedValue({ films: [film({ title: "Foreign", date: "2026-08-13" })], rejected: [] } as never);
    expect(await discoverNewsNet("ott", FROM, TO)).toEqual([]);
  });
});

describe("theatrical intent tags its finds theatrically", () => {
  it("a theatrical find carries releaseType theatrical and NO ottDate", async () => {
    mockSearch.mockResolvedValue({
      movie: [{ id: 5, title: "Panchali Panchabhartruka", year: 2026, originalLanguage: "te", releaseDate: "2026-08-14" }],
      tv: [],
    } as never);
    mockClaude.mockResolvedValue({
      films: [film({ title: "Panchali Panchabhartruka", language: "Telugu", date: "2026-08-14" })],
      rejected: [],
    } as never);

    const out = await discoverNewsNet("theatrical", FROM, TO);

    expect(out).toHaveLength(1);
    expect(out[0]!.releaseType).toBe("theatrical");
    expect(out[0]!.ottDate).toBeUndefined();
    expect(out[0]!.releaseDate).toBe("2026-08-14");
  });
});

describe("fail-safe / additive — and the WD-ENG-13 streak counter is wired", () => {
  it("every query failing degrades to [] and never throws", async () => {
    mockFetch.mockRejectedValue(new Error("Google News 503"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    await expect(discoverNewsNet("ott", FROM, TO)).resolves.toEqual([]);
    // The per-query warns plus the final degrade line.
    expect(warn.mock.calls.some((c) => /consecutive failed attempts: 1/.test(String(c[0])))).toBe(true);
  });

  it("the streak escalates on repeated failure — the ENG-13 wording", async () => {
    mockFetch.mockRejectedValue(new Error("Google News 503"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    for (let i = 0; i < 3; i++) await discoverNewsNet("ott", FROM, TO);

    expect(warn.mock.calls.some((c) => /is DEAD, not flaky/.test(String(c[0])))).toBe(true);
  });

  it("0 extracted films from a non-empty feed is a LOUD coverage warn, not silence", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    mockClaude.mockResolvedValue({ films: [], rejected: [] } as never);

    await expect(discoverNewsNet("ott", FROM, TO)).resolves.toEqual([]);
    expect(warn.mock.calls.some((c) => /COVERAGE/.test(String(c[0])))).toBe(true);
  });

  it("an extraction throw degrades to [] rather than taking discovery down", async () => {
    mockClaude.mockRejectedValue(new Error("LLM 529"));
    vi.spyOn(log, "warn").mockImplementation(() => {});
    vi.spyOn(log, "error").mockImplementation(() => {});
    await expect(discoverNewsNet("ott", FROM, TO)).resolves.toEqual([]);
  });
});

describe("the NEWS DESK is byte-unchanged — this net borrowed, it did not edit", () => {
  it("news-gather still exports its own queries and parser untouched", async () => {
    const { NEWS_QUERIES, parseNewsFeed, feedUrl } = await import("../../content/news/news-gather.js");
    // The desk's seven news-shaped queries are NOT the discovery set.
    expect(NEWS_QUERIES).toHaveLength(7);
    expect(NEWS_QUERIES.map((q) => q.query).join("|")).toContain("film news OTT release");
    // Its own 2-day feed window is unchanged; the net uses 7d via its own helper.
    expect(decodeURIComponent(feedUrl("x"))).toContain("when:2d");
    expect(typeof parseNewsFeed).toBe("function");
  });

  it("the net reuses the desk's parser rather than cloning it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/discovery/sources/newsNet.ts"), "utf8");
    expect(src).toContain('from "../../content/news/news-gather.js"');
    expect(src).toContain("parseNewsFeed");
    // A second RSS parser in the codebase is exactly the drift this avoids.
    expect(src).not.toContain("XMLParser");
  });
});
