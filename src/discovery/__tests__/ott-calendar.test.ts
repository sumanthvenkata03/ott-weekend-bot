// ott-calendar.test.ts — pins discovery's OTT-CALENDAR source (V3). The HEADLINE
// proof: the REAL frozen Filmibeat roundup body (the page that lists Blast) is
// fed in as the fetched body; a mocked extraction yields Blast; the SHARED
// resolveTitleToTmdb resolves it to its real id 1515729 and the source emits a
// DiscoveredFilm carrying the press OTT date / platform with releaseType
// "digital" and foundIn ["ott-calendar"]. Then the two fail-safe paths.
//
// Mocked: fetchCached (the page fetch), callClaudeJSON (the LLM), the extraction
// cache (passthrough), and searchTitleTmdb (the TMDb resolve) → fully offline.
// REAL: discoverOttCalendar, the node-html-parser flatten, resolveTitleToTmdb,
// normalizeTitle. The fixture is the actual captured page — no network.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));

// WD-ENG-13 — the streak LEDGER is stubbed in memory; the two MESSAGE BUILDERS
// are the real ones. Two reasons, both load-bearing:
//   1. Without this, every case here wrote data/source-health.json in the repo
//      and the counter carried BETWEEN cases (observed: 1 → 2 → 3), so this
//      file's assertions depended on its own execution order and every suite
//      run mutated tracked-adjacent state.
//   2. Keeping degradationLine/recoveryLine real means the wording assertions
//      below still exercise production code rather than a fake.
// The counter is reset per case in beforeEach.
const healthStub = vi.hoisted(() => ({ failures: 0, lastSuccess: null as string | null }));
vi.mock("../sources/source-health.js", async (orig) => {
  const real = await orig<typeof import("../sources/source-health.js")>();
  return {
    ...real,
    recordSourceFailure: vi.fn(() => ({
      consecutiveFailures: ++healthStub.failures,
      firstFailureAt: "2026-08-01T00:00:00.000Z",
      lastSuccessAt: healthStub.lastSuccess,
    })),
    recordSourceSuccess: vi.fn(() => {
      const before = {
        consecutiveFailures: healthStub.failures,
        firstFailureAt: healthStub.failures ? "2026-08-01T00:00:00.000Z" : null,
        lastSuccessAt: healthStub.lastSuccess,
      };
      healthStub.failures = 0;
      healthStub.lastSuccess = "2026-08-02T00:00:00.000Z";
      return before;
    }),
  };
});
vi.mock("../../research/http.js", () => ({ fetchCached: vi.fn() }));
vi.mock("../../content/claude.js", () => ({ callClaudeJSON: vi.fn() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({ searchTitleTmdb: vi.fn() }));

import { fetchCached } from "../../research/http.js";
import { callClaudeJSON } from "../../content/claude.js";
import { searchTitleTmdb } from "../../ingestion/releases/tmdb.js";
import { log } from "../../shared/logger.js";
import { discoverOttCalendar } from "../sources/ottCalendar.js";
import { loadOttCalendarHtml } from "./helpers/load.js";

const mockFetch = vi.mocked(fetchCached);
const mockClaude = vi.mocked(callClaudeJSON);
const mockSearch = vi.mocked(searchTitleTmdb);

// The REAL captured roundup body — the page that lists Blast in its body.
const FILMIBEAT_BODY = loadOttCalendarHtml("filmibeat-2026-06-26.html");

beforeEach(() => {
  vi.clearAllMocks();

  // WD-ENG-13 — each case starts from a clean streak, so no assertion here
  // depends on what an earlier case in this file did.
  healthStub.failures = 0;
  healthStub.lastSuccess = null;

  // The page fetch returns the full, untruncated body (the thing Tavily's
  // snippet lacked).
  mockFetch.mockResolvedValue({ value: FILMIBEAT_BODY, cached: false } as never);

  // The OWN extraction over the flattened body: one OTT film — Blast,
  // Tamil/Netflix/June-25.
  mockClaude.mockResolvedValue({
    films: [{
      title: "Blast",
      language: "Tamil",
      platform: "Netflix",
      date: "2026-06-25",
      isSeries: false,
      sources: [],
      confidence: "high",
    }],
    rejected: [],
  } as never);

  // TMDb resolve: Blast is a real Tamil 2026 movie under its REAL id 1515729.
  mockSearch.mockResolvedValue({
    movie: [{ id: 1515729, title: "Blast", year: 2026, originalLanguage: "ta", releaseDate: "2026-06-25" }],
    tv: [],
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverOttCalendar — full-body fetch → flatten → own extraction → shared resolve", () => {
  it("🔒 fixture contains Blast (the page that lists it in its BODY)", () => {
    expect(FILMIBEAT_BODY.toLowerCase()).toContain("blast");
  });

  it("🔒 HEADLINE: Blast extracted from the saved Filmibeat BODY → DiscoveredFilm (id 1515729, ott 2026-06-25, Netflix)", async () => {
    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");

    expect(films).toHaveLength(1);
    const f = films[0]!;
    expect(f.tmdbId).toBe(1515729);            // the REAL id, not the 55555 placeholder
    expect(f.title).toBe("Blast");
    expect(f.language).toBe("Tamil");
    expect(f.releaseType).toBe("digital");
    expect(f.ottDate).toBe("2026-06-25");      // ← the press date TMDb's net misses
    expect(f.platform).toBe("Netflix");
    expect(f.foundIn).toContain("ott-calendar");
    // No per-film URL from the body → the page itself is the provenance.
    expect(f.sourceUrl).toContain("filmibeat.com");
    expect(mockClaude).toHaveBeenCalledTimes(1); // exactly ONE LLM extraction (decoupled, own call)
  });

  it("a NON-Indian resolved language is dropped (the Indian guard)", async () => {
    mockSearch.mockResolvedValue({
      movie: [{ id: 7, title: "Blast", year: 2026, originalLanguage: "en", releaseDate: "2026-06-25" }],
      tv: [],
    } as never);
    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toEqual([]);
  });
});

describe("discoverOttCalendar — fail-safe / additive (never throws)", () => {
  it("fetch throws → returns [] (degrade; no LLM call)", async () => {
    mockFetch.mockRejectedValue(new Error("Cloudflare 403"));
    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toEqual([]);
    expect(mockClaude).not.toHaveBeenCalled();
  });

  it("🔒 SILENT-BREAK TRIPWIRE: non-empty body but 0 films extracted → LOUD parse-break warn + []", async () => {
    const warn = vi.spyOn(log, "warn");
    mockFetch.mockResolvedValue({ value: "<html><body>nothing parseable here</body></html>", cached: false } as never);
    mockClaude.mockResolvedValue({ films: [], rejected: [] } as never);

    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");

    expect(films).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/COVERAGE.*extracted 0 films.*possible scrape\/parser break/);
  });

  it("extraction throws → returns [] (degrade)", async () => {
    mockClaude.mockRejectedValue(new Error("LLM 529 overloaded"));
    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WD-ENG-13 ITEM 1b — THE LINE CHANGES WHEN THE SITUATION CHANGES.
//
// WD-ENG-12 found this source contributing zero films across five consecutive
// real runs while printing an identical warn every time, and WD-ENG-13's live
// diagnosis established why: Cloudflare returns 403 to the project's User-Agent
// on every request, deterministically. A line that reads the same on attempt 1
// and attempt 50 cannot convey that, which is why it stopped being read.
//
// These cases pin the wording THROUGH the real generator, not just through the
// builder's unit tests: the streak reaches the escalation from actual
// discoverOttCalendar calls, and a success genuinely resets it.
describe("WD-ENG-13 — the degradation line escalates, and a success resets it", () => {
  const failFetch = () => mockFetch.mockRejectedValue(new Error("Cloudflare 403"));

  it("the first failures read as transient — reason first, count as a suffix", async () => {
    const warn = vi.spyOn(log, "warn");
    failFetch();

    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(warn.mock.calls[0]![0]).toContain("consecutive failed attempts: 1");
    expect(warn.mock.calls[0]![0]).not.toContain("DEAD");

    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(warn.mock.calls[1]![0]).toContain("consecutive failed attempts: 2");
    expect(warn.mock.calls[1]![0]).not.toContain("DEAD");
  });

  it("THE ESCALATION — the third consecutive failure says DEAD, not flaky", async () => {
    const warn = vi.spyOn(log, "warn");
    failFetch();

    for (let i = 0; i < 3; i++) await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");

    const third = warn.mock.calls[2]![0] as string;
    expect(third).toContain("is DEAD, not flaky");
    expect(third).toContain("3 consecutive failed attempts");
    expect(third).toContain("last success: never recorded");
    // The reason survives the escalation — a reader still learns WHICH mode failed.
    expect(third).toContain("Cloudflare 403");
    // …and it is genuinely a different line from the pre-threshold one.
    expect(third).not.toBe(warn.mock.calls[1]![0]);
  });

  it("every one of the four degradation MODES routes through the counter", async () => {
    const warn = vi.spyOn(log, "warn");

    // 1. fetch throws
    failFetch();
    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    // 2. body flattens to empty
    mockFetch.mockResolvedValue({ value: "<html><body></body></html>", cached: false } as never);
    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    // 3. extraction throws
    mockFetch.mockResolvedValue({ value: FILMIBEAT_BODY, cached: false } as never);
    mockClaude.mockRejectedValue(new Error("LLM 529"));
    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    // 4. extracted 0 films
    mockClaude.mockResolvedValue({ films: [], rejected: [] } as never);
    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");

    // Four distinct modes, one shared streak: 1, 2, 3, 4 — none of them silent,
    // and none of them resetting another's count.
    const counts = warn.mock.calls.map((c) => String(c[0]));
    expect(counts[0]).toContain("consecutive failed attempts: 1");
    expect(counts[1]).toContain("consecutive failed attempts: 2");
    expect(counts[2]).toContain("3 consecutive failed attempts");
    expect(counts[3]).toContain("4 consecutive failed attempts");
  });

  it("A SUCCESS RESETS IT and announces the recovery exactly once", async () => {
    const warn = vi.spyOn(log, "warn");
    const success = vi.spyOn(log, "success");

    failFetch();
    for (let i = 0; i < 3; i++) await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(warn.mock.calls.at(-1)![0]).toContain("is DEAD");

    // The source comes back: real body, real extraction, one resolved film.
    mockFetch.mockResolvedValue({ value: FILMIBEAT_BODY, cached: false } as never);
    mockClaude.mockResolvedValue({
      films: [{ title: "Blast", language: "Tamil", platform: "Netflix", date: "2026-06-25", isSeries: false, sources: [] }],
      rejected: [],
    } as never);
    mockSearch.mockResolvedValue({
      movie: [{ id: 1515729, title: "Blast", year: 2026, originalLanguage: "ta", releaseDate: "2026-06-25" }],
      tv: [],
    } as never);

    const films = await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toHaveLength(1);
    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0]![0]).toContain("RECOVERED after 3 consecutive failed attempt(s)");

    // …and the NEXT failure starts a fresh streak rather than resuming at 4.
    failFetch();
    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(warn.mock.calls.at(-1)![0]).toContain("consecutive failed attempts: 1");
  });

  it("a HEALTHY run stays silent — no recovery line when there was no streak", async () => {
    const success = vi.spyOn(log, "success");
    mockClaude.mockResolvedValue({
      films: [{ title: "Blast", language: "Tamil", platform: "Netflix", date: "2026-06-25", isSeries: false, sources: [] }],
      rejected: [],
    } as never);
    mockSearch.mockResolvedValue({
      movie: [{ id: 1515729, title: "Blast", year: 2026, originalLanguage: "ta", releaseDate: "2026-06-25" }],
      tv: [],
    } as never);

    await discoverOttCalendar(["Tamil"], "2026-06-22", "2026-06-28");
    expect(success).not.toHaveBeenCalled();
  });
});
