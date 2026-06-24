// tmdb-discover.test.ts — pins the TMDb "net": result→film mapping, the
// two-pass (theatrical + digital) union by tmdbId, the digital-date honesty
// flags (A1/A2), pagination, the hard page ceiling, and graceful failure.
//
// Mock (hoisted): the whole tmdb.js module is replaced, so its real body never
// runs — that means NO network, NO SQLite cache open, and crucially NO
// config.ts import (which would process.exit(1) without a full .env).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../ingestion/releases/tmdb.js", () => ({ tmdbFetchCached: vi.fn() }));

import { tmdbFetchCached } from "../../ingestion/releases/tmdb.js";
import { discoverTmdb } from "../sources/tmdbDiscover.js";
import { log } from "../../shared/logger.js";
import { loadTmdb, tmdbPage } from "./helpers/load.js";
import { tmdbRouter } from "./helpers/mocks.js";

const mockTmdb = vi.mocked(tmdbFetchCached);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("discoverTmdb — mapping & passes", () => {
  it("maps a result to a DiscoveredFilm (tmdbId / year / language / releaseDate / releaseType)", async () => {
    mockTmdb.mockImplementation(
      tmdbRouter({ "te|theatrical|1": tmdbPage([{ id: 111, title: "Mapped Film", release_date: "2026-03-15" }]) }) as never
    );
    const { films } = await discoverTmdb(["Telugu"], "2026-03-01", "2026-03-31");
    expect(films).toHaveLength(1);
    expect(films[0]).toMatchObject({
      title: "Mapped Film",
      normalizedTitle: "mapped film",
      tmdbId: 111,
      year: 2026,
      language: "Telugu",
      releaseDate: "2026-03-15",
      releaseType: "theatrical",
      foundIn: ["tmdb"],
      perSource: { tmdb: { tmdbId: 111, title: "Mapped Film", releaseType: "theatrical", language: "Telugu" } },
    });
    expect(films[0]?.approximateDate).toBeUndefined();
  });

  it("maps the captured real Telugu pages into well-formed films", async () => {
    mockTmdb.mockImplementation(
      tmdbRouter({
        "te|theatrical|1": loadTmdb("telugu-theatrical.json"),
        "te|digital|1": loadTmdb("telugu-digital.json"),
      }) as never
    );
    const { films, coverage } = await discoverTmdb(["Telugu"], "2026-01-01", "2026-03-31");
    expect(films.length).toBeGreaterThan(0);
    for (const f of films) {
      expect(typeof f.tmdbId).toBe("number");
      expect(f.language).toBe("Telugu");
      expect(f.normalizedTitle.length).toBeGreaterThan(0);
      expect(["theatrical", "digital", "both"]).toContain(f.releaseType);
    }
    const psych = films.find((f) => f.tmdbId === 1594670);
    expect(psych).toMatchObject({ year: 2026, releaseDate: "2026-01-01", language: "Telugu" });
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, count: films.length }]);
  });

  it("🔒 digital pass merges with theatrical by tmdbId -> releaseType 'both'", async () => {
    const movie = { id: 500, title: "Both Film", release_date: "2026-01-10" };
    mockTmdb.mockImplementation(
      tmdbRouter({ "te|theatrical|1": tmdbPage([movie]), "te|digital|1": tmdbPage([movie]) }) as never
    );
    const { films } = await discoverTmdb(["Telugu"], "2026-01-01", "2026-01-31");
    expect(films).toHaveLength(1);
    expect(films[0]?.releaseType).toBe("both");
  });
});

describe("discoverTmdb — digital-date honesty (🔒 A1/A2)", () => {
  it("🔒 A1: a digital hit whose PRIMARY date sits OUTSIDE the window is still INCLUDED", async () => {
    // Trust TMDb's server-side digital filter; do NOT re-filter on release_date.
    mockTmdb.mockImplementation(
      tmdbRouter({ "te|digital|1": loadTmdb("edge-digital-out-of-window.json") }) as never
    );
    const { films } = await discoverTmdb(["Telugu"], "2026-02-01", "2026-02-28");
    expect(films).toHaveLength(1);
    expect(films[0]).toMatchObject({
      tmdbId: 900001,
      releaseType: "digital",
      releaseDate: "2025-11-15", // primary date, before the queried window
      year: 2025,
    });
  });

  it("🔒 A2: that out-of-window digital film is flagged approximate with a caveat note", async () => {
    mockTmdb.mockImplementation(
      tmdbRouter({ "te|digital|1": loadTmdb("edge-digital-out-of-window.json") }) as never
    );
    const { films } = await discoverTmdb(["Telugu"], "2026-02-01", "2026-02-28");
    expect(films[0]?.approximateDate).toBe(true);
    expect(films[0]?.note).toBe("in-range digital release; date shown is TMDb primary date");
  });
});

describe("discoverTmdb — pagination & ceiling", () => {
  it("🔒 follows total_pages>1 and fetches every page", async () => {
    mockTmdb.mockImplementation(
      tmdbRouter({
        "te|theatrical|1": loadTmdb("edge-multipage-p1.json"),
        "te|theatrical|2": loadTmdb("edge-multipage-p2.json"),
      }) as never
    );
    const { films } = await discoverTmdb(["Telugu"], "2026-01-01", "2026-01-31");
    expect(films.map((f) => f.tmdbId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([701, 702, 703, 704]);
    // theatrical page 1 + page 2 were both requested.
    const theatricalPages = mockTmdb.mock.calls
      .filter((c) => (c[1] as Record<string, string>).with_release_type !== "4")
      .map((c) => (c[1] as Record<string, string>).page);
    expect(theatricalPages).toContain("1");
    expect(theatricalPages).toContain("2");
  });

  it("🔒 stops at the 25-page ceiling and emits a LOUD truncation warn (never a silent cap)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const tmpl = loadTmdb("edge-ceiling.json"); // total_pages: 30
    mockTmdb.mockImplementation((async (_path: string, params: Record<string, string>) => {
      const page = Number.parseInt(params.page ?? "1", 10);
      return { ...tmpl, page, results: [{ id: 1000 + page, title: `Ceil ${page}`, release_date: "2026-01-01" }] };
    }) as never);

    const { films } = await discoverTmdb(["Telugu"], "2026-01-01", "2026-12-31");

    // Pages 1..25 only — never page 26.
    const pagesRequested = mockTmdb.mock.calls.map((c) => (c[1] as Record<string, string>).page);
    expect(pagesRequested).toContain("25");
    expect(pagesRequested).not.toContain("26");
    // Both passes yield ids 1001..1025 -> union by id = 25 distinct films.
    expect(films).toHaveLength(25);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TRUNCATED.*total_pages=30/s));
  });
});

describe("discoverTmdb — graceful degradation", () => {
  it("a fetch that throws -> [] for that language + a warn, no crash", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    mockTmdb.mockRejectedValue(new Error("tmdb 500"));
    const { films, coverage } = await discoverTmdb(["Telugu"], "2026-01-01", "2026-01-31");
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, count: 0 }]);
    expect(warn).toHaveBeenCalled();
  });

  it("an unknown language is skipped with a warn (no code mapping)", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    mockTmdb.mockImplementation(tmdbRouter({}) as never);
    const { films, coverage } = await discoverTmdb(["Klingon"], "2026-01-01", "2026-01-31");
    expect(films).toEqual([]);
    expect(coverage).toEqual([]); // unknown languages produce no coverage rows
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Klingon"));
  });
});
