// ott-search.test.ts — pins discovery's AI-search OTT source: a mocked Tavily +
// Claude extraction yielding a Blast-like film resolves to its TMDb id and emits
// a DiscoveredFilm carrying the PRESS ott date / platform with releaseType
// "digital". Tavily (fetchCached), the LLM (callClaudeJSON), the extraction cache
// (cached), and the TMDb resolve (searchTitleTmdb) are all mocked → fully offline.
// resolveTitleToTmdb + normalizeTitle run REAL (the resolve logic is proven here).
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
import { discoverOttSearch } from "../sources/ottSearch.js";

const mockFetch = vi.mocked(fetchCached);
const mockClaude = vi.mocked(callClaudeJSON);
const mockSearch = vi.mocked(searchTitleTmdb);

let savedKey: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "tvly-test"; // runAiNet returns empty without a key

  // Tavily: every query returns the same Blast snippet (deduped to one).
  mockFetch.mockResolvedValue({
    value: { results: [{ url: "https://news.example/blast", title: "Blast", content: "Blast streams on Netflix June 25" }] },
    cached: false,
  } as never);

  // Claude extraction: one OTT film, Tamil/Netflix/June-25 (theatrical-in-TMDb-as-May).
  mockClaude.mockResolvedValue({
    films: [{
      title: "Blast",
      language: "Tamil",
      platform: "Netflix",
      date: "2026-06-25",
      isSeries: false,
      sources: [{ url: "https://news.example/blast" }],
      confidence: "high",
    }],
    rejected: [],
    dateConflict: [],
  } as never);

  // TMDb resolve: Blast is a real Tamil 2026 movie under id 55555.
  mockSearch.mockResolvedValue({
    movie: [{ id: 55555, title: "Blast", year: 2026, originalLanguage: "ta", releaseDate: "2026-06-25" }],
    tv: [],
  } as never);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = savedKey;
  vi.restoreAllMocks();
});

describe("discoverOttSearch — extraction → resolve → DiscoveredFilm", () => {
  it("🔒 a Blast-like OTT find resolves to its tmdbId and carries the press ott date + platform", async () => {
    const films = await discoverOttSearch(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toHaveLength(1);
    const f = films[0]!;
    expect(f.tmdbId).toBe(55555);
    expect(f.title).toBe("Blast");
    expect(f.language).toBe("Tamil");
    expect(f.releaseType).toBe("digital");
    expect(f.ottDate).toBe("2026-06-25");      // ← the press date TMDb's net misses
    expect(f.platform).toBe("Netflix");
    expect(f.sourceUrl).toBe("https://news.example/blast");
    expect(f.foundIn).toEqual(["ai-ott"]);
    expect(mockClaude).toHaveBeenCalledTimes(1); // ≤1 LLM extraction per OTT window
  });

  it("no Tavily key → empty (no LLM call)", async () => {
    delete process.env.TAVILY_API_KEY;
    const films = await discoverOttSearch(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toEqual([]);
    expect(mockClaude).not.toHaveBeenCalled();
  });

  it("a NON-Indian resolved language is dropped (the guard), even with a movie hit", async () => {
    mockSearch.mockResolvedValue({
      movie: [{ id: 7, title: "Blast", year: 2026, originalLanguage: "en", releaseDate: "2026-06-25" }],
      tv: [],
    } as never);
    const films = await discoverOttSearch(["Tamil"], "2026-06-22", "2026-06-28");
    expect(films).toEqual([]);
  });
});
