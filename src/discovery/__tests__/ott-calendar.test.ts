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
