// wikipedia-parser.test.ts — pins the Wikipedia "net": the rowspan-grid parser
// (parsePage, the core hazard) and the fetch+coverage wrapper (discoverWikipedia).
//
// Mocks (hoisted): `ofetch` is replaced so no network is hit, and the SQLite
// cache wrapper is replaced with a pass-through so `data/cache.sqlite` is never
// opened. Importing wikipediaList.js alone would otherwise open the DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("../../shared/cache.js", () => ({
  // Pass-through: run the loader directly. Preserves the real contract that a
  // throwing loader propagates (and so is never persisted) WITHOUT touching SQLite.
  cached: (_key: string, loader: () => unknown) => loader(),
}));

import { ofetch } from "ofetch";
import { parsePage, discoverWikipedia } from "../sources/wikipediaList.js";
import { log } from "../../shared/logger.js";
import {
  loadWikiHtml,
  loadWikiResponse,
  readSyntheticHtml,
  type WikiParseResponse,
} from "./helpers/load.js";
import { wikiOfetch } from "./helpers/mocks.js";

const mockOfetch = vi.mocked(ofetch);
const FULL_2026 = ["2026-01-01", "2026-12-31"] as const;
const FULL_2025 = ["2025-01-01", "2025-12-31"] as const;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── parsePage against hand-built synthetic HTML (full control) ───────────────
describe("parsePage — synthetic structural fixtures", () => {
  it("🔒 rowspan: inherits month+day down trailing rows; month span terminates", () => {
    const { films, skipped } = parsePage(
      readSyntheticHtml("rowspan.html"), "Tamil", 2026, "p", ...FULL_2026
    );
    expect(skipped).toBe(0);
    const byTitle = Object.fromEntries(films.map((f) => [f.title, f.releaseDate]));
    expect(byTitle).toEqual({
      Alpha: "2026-01-05",   // first row of a multi-film day
      Bravo: "2026-01-05",   // trailing row (fewer physical cells) inherits day
      Charlie: "2026-01-06", // month carried, new day
      Delta: "2026-02-10",   // JANUARY rowspan ended — must NOT leak into February
    });
  });

  it("🔒 <style> pollution: month resolves; the film is NOT silently dropped (the January bug)", () => {
    const { films } = parsePage(
      readSyntheticHtml("style-pollution.html"), "Telugu", 2026, "p", ...FULL_2026
    );
    // Without stripping the TemplateStyles <style>, the month text would read
    // ".mw-parser-output...JANUARY" and resolve to no month -> film dropped.
    expect(films.map((f) => [f.title, f.releaseDate])).toEqual([["StyleJan", "2026-01-07"]]);
  });

  it("month encodings: full name, <br>-letter vertical, and 3-letter abbreviations all resolve", () => {
    const { films } = parsePage(
      readSyntheticHtml("months.html"), "Tamil", 2026, "p", ...FULL_2026
    );
    expect(Object.fromEntries(films.map((f) => [f.title, f.releaseDate]))).toEqual({
      FullJan: "2026-01-10",
      BrAug: "2026-08-11",
      PlainAug: "2026-08-12",
      PlainSep: "2026-09-13",
    });
  });

  it("🔒 table selection: Box-office and 'Upcoming releases' tables are skipped (no Opening header)", () => {
    const { films, skipped } = parsePage(
      readSyntheticHtml("parsed-zero.html"), "Tamil", 2026, "p", ...FULL_2026
    );
    expect(films).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("defensive fallback: a single free-text 'Opening' column parses without crashing", () => {
    const { films } = parsePage(
      readSyntheticHtml("freetext-single.html"), "Tamil", 2026, "p", ...FULL_2026
    );
    const freeText = films.find((f) => f.title === "FreeText");
    const monthOnly = films.find((f) => f.title === "MonthOnly");
    expect(freeText?.releaseDate).toBe("2026-08-15");
    expect(freeText?.approximateDate).toBeUndefined();
    expect(monthOnly?.releaseDate).toBe("2026-09-01");
    expect(monthOnly?.approximateDate).toBe(true); // month-only -> approximate
  });

  it("row missing a title is skipped and tallied", () => {
    const { films, skipped } = parsePage(
      readSyntheticHtml("missing-title.html"), "Tamil", 2026, "p", ...FULL_2026
    );
    expect(films.map((f) => f.title)).toEqual(["Valid"]);
    expect(skipped).toBe(1);
  });

  it("emits full provenance on each film", () => {
    const [first] = parsePage(readSyntheticHtml("rowspan.html"), "Tamil", 2026, "List X", ...FULL_2026).films;
    expect(first).toMatchObject({
      title: "Alpha",
      normalizedTitle: "alpha",
      year: 2026,
      language: "Tamil",
      foundIn: ["wikipedia"],
      perSource: { wikipedia: { title: "Alpha", page: "List X", language: "Tamil" } },
    });
  });
});

// ── parsePage against the captured real pages (faithfulness) ─────────────────
describe("parsePage — captured real pages", () => {
  it("Telugu 2026: parses the standard layout (98 films, 0 skipped)", () => {
    const { films, skipped } = parsePage(loadWikiHtml("telugu-2026.json"), "Telugu", 2026, "p", ...FULL_2026);
    expect(films.length).toBe(98);
    expect(skipped).toBe(0);
  });

  it("🔒 real rowspan: the four Jan-1 Telugu films all inherit 2026-01-01", () => {
    const { films } = parsePage(loadWikiHtml("telugu-2026.json"), "Telugu", 2026, "p", "2026-01-01", "2026-01-01");
    expect(films.map((f) => f.title).sort()).toEqual(
      ["Madham", "Psych Siddhartha", "Sahakutumbaanaam", "Vanaveera"]
    );
    expect(films.every((f) => f.releaseDate === "2026-01-01")).toBe(true);
  });

  it("🔒 <style> pollution (real Malayalam 2025 Q1): all 31 January films survive", () => {
    const { films } = parsePage(loadWikiHtml("malayalam-2025.json"), "Malayalam", 2025, "p", ...FULL_2025);
    const january = films.filter((f) => f.releaseDate?.startsWith("2025-01"));
    expect(january.length).toBe(31);
    expect(january.some((f) => f.title === "Identity")).toBe(true);
  });

  it("abbreviated months resolve on the real Tamil 2026 page (Aug + Sep present)", () => {
    const { films, skipped } = parsePage(loadWikiHtml("tamil-2026.json"), "Tamil", 2026, "p", ...FULL_2026);
    expect(films.length).toBe(97);
    expect(skipped).toBe(4); // real rows that legitimately fail title/date parse
    expect(films.some((f) => f.releaseDate?.startsWith("2026-08"))).toBe(true);
    expect(films.some((f) => f.releaseDate?.startsWith("2026-09"))).toBe(true);
  });

  it("🔒 Kannada 2026: the standard quarter layout parses in full (131 films, 0 skipped) — canary vs a silent parse/list regression", () => {
    // Captured live 2026-07 (tables-only trim). The page that supposedly "parsed
    // 0" in fact uses the same Opening|Title|Director|Cast|Studio|Ref quarter
    // layout as te/ta/ml and parses cleanly — this pins that so a real future
    // break (or list gap) is caught by the COVERAGE canary, not chased as a ghost.
    const { films, skipped } = parsePage(loadWikiHtml("kannada-2026.json"), "Kannada", 2026, "p", ...FULL_2026);
    expect(films.length).toBe(131);
    expect(skipped).toBe(0);
    // rowspan + month resolution work across the whole year (Jan…Oct present)
    expect(new Set(films.map((f) => f.releaseDate?.slice(0, 7))).size).toBeGreaterThanOrEqual(8);
    expect(films.some((f) => f.title === "Shivaleela")).toBe(true);
  });

  it("🔒 date inclusivity: both `from` and `to` boundaries are INCLUDED, outside is EXCLUDED", () => {
    const html = loadWikiHtml("telugu-2026.json");
    expect(parsePage(html, "Telugu", 2026, "p", "2026-01-01", "2026-01-01").films.length).toBe(4); // on `from`==`to`
    expect(parsePage(html, "Telugu", 2026, "p", "2026-01-02", "2026-01-02").films.length).toBe(2); // on a boundary
    expect(parsePage(html, "Telugu", 2026, "p", "2026-01-01", "2026-01-02").films.length).toBe(6); // inclusive span
    const after = parsePage(html, "Telugu", 2026, "p", "2026-01-03", "2026-12-31").films;
    expect(after.every((f) => (f.releaseDate ?? "") >= "2026-01-03")).toBe(true); // Jan 1/2 excluded
  });
});

// ── discoverWikipedia: fetch + per-(language,year) coverage status ───────────
describe("discoverWikipedia — fetch + coverage status", () => {
  it("happy path: page exists -> status 'ok' with the in-range count", async () => {
    mockOfetch.mockImplementation(
      wikiOfetch({ "List of Telugu films of 2026": loadWikiResponse("telugu-2026.json") }) as never
    );
    const { films, coverage } = await discoverWikipedia(["Telugu"], "2026-01-01", "2026-01-02");
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "ok", count: 6 }]);
    expect(films.length).toBe(6);
  });

  it("404 / page-not-created -> [] and status 'missing'", async () => {
    mockOfetch.mockImplementation(
      wikiOfetch({ "List of Telugu films of 2026": loadWikiResponse("edge-missing.json") }) as never
    );
    const { films, coverage } = await discoverWikipedia(["Telugu"], ...FULL_2026);
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "missing", count: 0 }]);
  });

  it("malformed 200 (no parse.text) -> loader THROWS -> status 'error', degrades to [] (not cached)", async () => {
    // The throw means cached() would never persist it (verified by code review);
    // here cached() is bypassed, so we pin the observable degrade-to-error.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    mockOfetch.mockImplementation(
      wikiOfetch({ "List of Telugu films of 2026": loadWikiResponse("edge-malformed-200.json") }) as never
    );
    const { films, coverage } = await discoverWikipedia(["Telugu"], ...FULL_2026);
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "error", count: 0 }]);
    expect(warn).toHaveBeenCalled();
  });

  it("🔒 transient API error (ratelimited) -> loader THROWS -> status 'error', NOT cached as 'missing'", async () => {
    // A non-existence error code is transient: it must degrade to 'error' (and,
    // in production, NOT be persisted by cached()) so a later run retries —
    // never be mistaken for a genuinely absent page.
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const ratelimited: WikiParseResponse = { error: { code: "ratelimited", info: "Too many requests." } };
    mockOfetch.mockImplementation(wikiOfetch({ "List of Telugu films of 2026": ratelimited }) as never);
    const { films, coverage } = await discoverWikipedia(["Telugu"], ...FULL_2026);
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "error", count: 0 }]);
    expect(warn).toHaveBeenCalled();
  });

  it("🔒 genuine-absence code (missingtitle) still -> '' -> status 'missing'", async () => {
    const missing: WikiParseResponse = { error: { code: "missingtitle", info: "The page you specified doesn't exist." } };
    mockOfetch.mockImplementation(wikiOfetch({ "List of Telugu films of 2026": missing }) as never);
    const { films, coverage } = await discoverWikipedia(["Telugu"], ...FULL_2026);
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "missing", count: 0 }]);
  });

  it("🔒 page exists but parses 0 films -> status 'ok' with count 0 (the silent-parser-break signal)", async () => {
    const resp: WikiParseResponse = { parse: { title: "x", text: readSyntheticHtml("parsed-zero.html") } };
    mockOfetch.mockImplementation(wikiOfetch({ "List of Telugu films of 2026": resp }) as never);
    const { films, coverage } = await discoverWikipedia(["Telugu"], ...FULL_2026);
    expect(films).toEqual([]);
    expect(coverage).toEqual([{ language: "Telugu", year: 2026, status: "ok", count: 0 }]);
  });
});
