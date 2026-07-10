// discover-e2e.test.ts — pins the discover() orchestration with BOTH nets'
// fetch layers mocked (real union, real cross-net guard, real Promise.allSettled).
//
// tmdbDiscover.js is wrapped with a delegating mock: by default it runs the REAL
// net (against the mocked tmdbFetchCached); flipping netCtl.tmdbThrows makes the
// whole net reject, which is the only way to exercise discover()'s allSettled
// rejected branch (the nets never throw on their own).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const netCtl = vi.hoisted(() => ({ tmdbThrows: false }));

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("../../shared/cache.js", () => ({ cached: (_k: string, loader: () => unknown) => loader() }));
vi.mock("../../ingestion/releases/tmdb.js", () => ({ tmdbFetchCached: vi.fn() }));
vi.mock("../sources/tmdbDiscover.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../sources/tmdbDiscover.js")>();
  return {
    ...real,
    discoverTmdb: async (...args: Parameters<typeof real.discoverTmdb>) => {
      if (netCtl.tmdbThrows) throw new Error("TMDb net down");
      return real.discoverTmdb(...args);
    },
  };
});

import { ofetch } from "ofetch";
import { tmdbFetchCached } from "../../ingestion/releases/tmdb.js";
import { discover, SUPPORTED_LANGUAGES } from "../index.js";
import { log } from "../../shared/logger.js";
import { loadWikiResponse, loadTmdb, tmdbPage, readSyntheticHtml, type WikiParseResponse } from "./helpers/load.js";
import { wikiOfetch, tmdbRouter } from "./helpers/mocks.js";
import type { TmdbDiscoverResponse } from "./helpers/load.js";

const mockOfetch = vi.mocked(ofetch);
const mockTmdb = vi.mocked(tmdbFetchCached);

function setWiki(byPage: Record<string, WikiParseResponse>): void {
  mockOfetch.mockImplementation(wikiOfetch(byPage) as never);
}
function setTmdb(routes: Record<string, TmdbDiscoverResponse>): void {
  mockTmdb.mockImplementation(tmdbRouter(routes) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  netCtl.tmdbThrows = false;
  setWiki({}); // default: every page missing
  setTmdb({}); // default: every pass empty
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("discover — full run", () => {
  it("returns a well-formed DiscoveryResult with consistent stats and a both-net match", async () => {
    setWiki({ "List of Telugu films of 2026": loadWikiResponse("telugu-2026.json") });
    setTmdb({
      "te|theatrical|1": loadTmdb("telugu-theatrical.json"),
      "te|digital|1": loadTmdb("telugu-digital.json"),
    });

    const result = await discover({ from: "2026-01-01", to: "2026-01-31", languages: ["Telugu"] });

    expect(result.query.languages).toEqual(["Telugu"]);
    expect(result.films.length).toBeGreaterThan(0);
    expect(typeof result.ranAt).toBe("string");
    expect(new Date(result.ranAt).toISOString()).toBe(result.ranAt);

    // Stats are internally consistent.
    const { stats, films } = result;
    expect(stats.unionCount).toBe(films.length);
    expect(stats.onlyInTmdb + stats.onlyInWikipedia + stats.inBoth).toBe(films.length);

    // Psych Siddhartha (tmdb id 1594670 @ 2026-01-01) is also on the Wikipedia
    // page -> a genuine cross-net match.
    const psych = films.find((f) => f.normalizedTitle === "psych siddhartha");
    expect(psych?.foundIn.sort()).toEqual(["tmdb", "wikipedia"]);
    expect(stats.inBoth).toBeGreaterThanOrEqual(1);

    // Films are sorted by date ascending.
    const dates = films.map((f) => f.releaseDate ?? "￿");
    expect([...dates]).toEqual([...dates].sort());
  });
});

describe("discover — cross-net sanity guard (🔒 January-bug alarm)", () => {
  it("🔒 missing Wikipedia page while TMDb found films -> MILD info, not a warn", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    // wiki: Telugu page missing (default). tmdb: 1 film.
    setTmdb({ "te|theatrical|1": tmdbPage([{ id: 1, title: "Solo Tmdb", release_date: "2026-01-10" }]) });

    await discover({ from: "2026-01-01", to: "2026-01-31", languages: ["Telugu"] });

    expect(info).toHaveBeenCalledWith(expect.stringMatching(/no Wikipedia list page for Telugu 2026/));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/COVERAGE/));
  });

  it("🔒 page EXISTS but parsed 0 while TMDb found films -> LOUD coverage warn (silent-parser-break signal)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const zero: WikiParseResponse = { parse: { title: "x", text: readSyntheticHtml("parsed-zero.html") } };
    setWiki({ "List of Telugu films of 2026": zero });
    setTmdb({ "te|theatrical|1": tmdbPage([{ id: 1, title: "Solo Tmdb", release_date: "2026-01-10" }]) });

    await discover({ from: "2026-01-01", to: "2026-01-31", languages: ["Telugu"] });

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/COVERAGE: Wikipedia page for Telugu 2026 EXISTS but parsed 0/));
  });
});

describe("discover — resilience", () => {
  it("🔒 one net rejecting still returns a result built from the other net (Promise.allSettled)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    netCtl.tmdbThrows = true;
    setWiki({ "List of Telugu films of 2026": loadWikiResponse("telugu-2026.json") });

    const result = await discover({ from: "2026-01-01", to: "2026-01-31", languages: ["Telugu"] });

    expect(result.films.length).toBeGreaterThan(0);
    expect(result.stats.perNet.tmdb).toBe(0);
    expect(result.films.every((f) => f.foundIn.length === 1 && f.foundIn[0] === "wikipedia")).toBe(true);
    expect(warn).toHaveBeenCalledWith("TMDb net failed", expect.anything());
  });

  it("🔒 multi-year range keys the guard per (language, year) — only the missing year is flagged", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "warn").mockImplementation(() => {});
    // 2025 page missing (default); 2026 page present.
    setWiki({ "List of Telugu films of 2026": loadWikiResponse("telugu-2026.json") });
    // TMDb finds one film in EACH year, so the 2025 zero-Wikipedia gap is real.
    setTmdb({
      "te|theatrical|1": tmdbPage([
        { id: 1, title: "Dec 2025 Film", release_date: "2025-12-25" },
        { id: 2, title: "Jan 2026 Film", release_date: "2026-01-05" },
      ]),
    });

    await discover({ from: "2025-12-20", to: "2026-01-10", languages: ["Telugu"] });

    // The 2025 gap is flagged specifically; 2026 (which has a page) is not.
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/no Wikipedia list page for Telugu 2025/));
    expect(info).not.toHaveBeenCalledWith(expect.stringMatching(/no Wikipedia list page for Telugu 2026/));
  });
});

describe("discover — default & degenerate inputs", () => {
  it("empty languages list defaults to all 7 supported languages (incl. Punjabi; Bengali trimmed)", async () => {
    const result = await discover({ from: "2026-03-01", to: "2026-03-31", languages: [] });
    expect(result.query.languages).toHaveLength(7);
    expect(result.query.languages).toContain("Punjabi");
    expect(result.query.languages).not.toContain("Bengali");
    expect(SUPPORTED_LANGUAGES).toHaveLength(7);
  });

  it("a single-day range with nothing found returns a clean empty result (no throw)", async () => {
    const result = await discover({ from: "2026-03-15", to: "2026-03-15", languages: ["Telugu"] });
    expect(result.films).toEqual([]);
    expect(result.stats).toMatchObject({ unionCount: 0, onlyInTmdb: 0, onlyInWikipedia: 0, inBoth: 0 });
  });
});
