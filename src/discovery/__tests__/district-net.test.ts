// WD-ENG-18 — THE DISTRICT NET, driven off REAL captured District HTML.
//
// ── WHY THIS NET EXISTS ─────────────────────────────────────────────────────
// WD-ENG-15 found theatrical discovery running on exactly TWO nets — the TMDb
// theatrical pass and the Wikipedia year-lists. The two-net green rule needs two
// independent nets to agree, so with only two present a miss by either meant no
// theatrical film could reach green on nets alone. District was the only
// surveyed source carrying BOTH TMDb-less theatrical films with the correct date
// and language, and it answers 200 to the project UA (BookMyShow and Letterboxd
// both 403 it).
//
// ── PARSE-ONLY, AND WHY THAT IS THE POINT ───────────────────────────────────
// Every District detail page carries a complete schema.org/Movie JSON-LD block.
// WD-ENG-17D pulled the news net OFF the theatrical intent because its
// extraction billed an Anthropic call on all four theatrical pillars. This net
// restores theatrical redundancy with NO LLM, so those pillars stay free.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../research/http.js", () => ({ fetchCached: vi.fn() }));

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
import { log } from "../../shared/logger.js";
import {
  discoverDistrict,
  parseListing,
  parseMovieJsonLd,
  hasUsableDate,
  pillarLanguage,
  inWindow,
  toDiscoveredFilm,
  MAX_DETAIL_FETCHES,
} from "../sources/districtNet.js";
import { loadDistrictHtml } from "./helpers/load.js";

const mockFetch = vi.mocked(fetchCached);

const LISTING = loadDistrictHtml("listing.html");
const PANCHALI = loadDistrictHtml("panchali.html");
const PALLABURUSU = loadDistrictHtml("pallaburusu.html");
const AGADHA = loadDistrictHtml("agadha.html");

const FROM = "2026-08-12";
const TO = "2026-08-16";

/** Serve the listing first, then a detail page for every id. */
const serve = (fallback = PANCHALI) =>
  mockFetch.mockImplementation(async (key: string) => {
    if (String(key).includes(":listing")) return { value: LISTING, cached: false } as never;
    return { value: fallback, cached: false } as never;
  });

beforeEach(() => {
  vi.clearAllMocks();
  healthStub.failures = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("the captured listing parses into stable film links", () => {
  it("yields unique MV ids with slugs and URLs", () => {
    const entries = parseListing(LISTING);
    expect(entries.length).toBeGreaterThan(20);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length); // deduped
    for (const e of entries.slice(0, 5)) {
      expect(e.id).toMatch(/^MV\d+$/);
      expect(e.url).toContain("district.in/movies/");
    }
  });

  it("🔒 THE LISTING CARRIES NO DATES — which is why a detail fetch is required", () => {
    // Verified live and pinned: the cost of this net (1 + N requests) follows
    // from this fact. If District ever puts dates on the listing, this pin fails
    // and the sweep can be made cheaper deliberately rather than by accident.
    const text = LISTING.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
    expect(/Released/.test(text)).toBe(false);
    expect(/\d{1,2} August 2026/.test(text)).toBe(false);
  });
});

describe("PART 1c — the films ENG-15 named are still carried, correctly", () => {
  it.each([
    ["Panchali Panchabhartruka", () => PANCHALI, "2026-08-14", "Telugu"],
    ["Pallaburusu", () => PALLABURUSU, "2026-08-14", "Telugu"],
    ["Agadha", () => AGADHA, "2026-08-14", "Telugu"],
  ])("%s parses with the right date and language", (title, html, date, language) => {
    const m = parseMovieJsonLd(html())!;
    expect(m).not.toBeNull();
    expect(m.name).toBe(title);
    expect(m.datePublished).toBe(date);
    expect(pillarLanguage(m.inLanguage)).toBe(language);
  });

  it("the JSON-LD also carries the fields a card can use", () => {
    const m = parseMovieJsonLd(PANCHALI)!;
    expect(m.genre).toEqual(["Comedy", "Thriller"]);
    expect(m.director).toBe("Ganga Sapthasikhara");
    expect(m.actors!.length).toBeGreaterThan(0);
    expect(m.description!.length).toBeGreaterThan(40);
  });

  it("a page with no Movie block returns null rather than guessing", () => {
    expect(parseMovieJsonLd("<html><body>no ld+json here</body></html>")).toBeNull();
    expect(parseMovieJsonLd('<script type="application/ld+json">{ broken</script>')).toBeNull();
  });
});

describe("PART 3 — no manufactured dates, and no TMDb-backing exception", () => {
  it("🔒 A DATELESS LISTING PRODUCES NO DATED CANDIDATE — the rule, in code", async () => {
    const dateless = PANCHALI.split('"datePublished":"2026-08-14"').join('"datePublished":""');
    serve(dateless);
    expect(await discoverDistrict(FROM, TO)).toEqual([]);
  });

  it("hasUsableDate refuses anything that is not an ISO date", () => {
    expect(hasUsableDate({ name: "x", datePublished: "2026-08-14" })).toBe(true);
    expect(hasUsableDate({ name: "x" })).toBe(false);
    expect(hasUsableDate({ name: "x", datePublished: "2026" })).toBe(false);
    expect(hasUsableDate({ name: "x", datePublished: "14 August 2026" })).toBe(false);
  });

  it("🔒 A DISTRICT FIND CARRIES NO releaseType AND NO tmdbId — it must earn admission", () => {
    // releaseType is what matchesIntent keys on. Setting it here would admit a
    // TMDb-less film straight into the pool — the exception this net must not
    // create. Left undefined, the find goes through resolveWikiOnlyFilms exactly
    // as a Wikipedia-only find does.
    const f = toDiscoveredFilm(
      { name: "X", datePublished: "2026-08-14", inLanguage: ["Telugu"] },
      "Telugu",
      "https://www.district.in/movies/x-movie-tickets-MV1"
    );
    expect(f.releaseType).toBeUndefined();
    expect(f.tmdbId).toBeUndefined();
    expect(f.foundIn).toEqual(["district"]);
  });

  it("the TMDb-backing resolver TARGETS district finds — the same gate as wikipedia", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/discovery/sources/resolveWikiFilm.ts"), "utf8");
    expect(src).toContain('f.foundIn.includes("district")');
    expect(src).toContain("f.releaseType === undefined");
  });

  it("candidates.ts unions District BEFORE resolution, not after the intent filter", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/discovery/candidates.ts"), "utf8");
    // Order IS the guard: unioning after matchesIntent would skip the gate.
    expect(src.indexOf("discoverDistrict(")).toBeLessThan(src.indexOf("resolveWikiOnlyFilms("));
    expect(src.indexOf("resolveWikiOnlyFilms(")).toBeLessThan(src.indexOf("matchesIntent(f, q.intent)"));
  });

  it("PARSE-ONLY — the net imports no Claude client", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/discovery/sources/districtNet.ts"), "utf8");
    expect(src).not.toContain("callClaudeJSON");
    expect(src).not.toContain("content/claude.js");
  });
});

describe("window and language filtering", () => {
  it("only in-window films survive", () => {
    expect(inWindow("2026-08-14", FROM, TO)).toBe(true);
    expect(inWindow("2026-08-11", FROM, TO)).toBe(false);
    expect(inWindow("2026-08-17", FROM, TO)).toBe(false);
  });

  it("a non-pillar language is dropped, not coerced", () => {
    expect(pillarLanguage(["English"])).toBeUndefined();
    expect(pillarLanguage(["Bengali"])).toBeUndefined(); // not one of the seven
    expect(pillarLanguage(["Telugu"])).toBe("Telugu");
    expect(pillarLanguage([])).toBeUndefined();
    expect(pillarLanguage(undefined)).toBeUndefined();
  });

  it("an out-of-window film produces no candidate", async () => {
    serve();
    expect(await discoverDistrict("2026-09-01", "2026-09-07")).toEqual([]);
  });

  it("an English listing produces no candidate", async () => {
    serve(PANCHALI.split('"inLanguage":["Telugu"]').join('"inLanguage":["English"]'));
    expect(await discoverDistrict(FROM, TO)).toEqual([]);
  });
});

describe("the happy path", () => {
  it("an in-window pillar film becomes a DiscoveredFilm tagged district", async () => {
    serve();
    const out = await discoverDistrict(FROM, TO);

    expect(out.length).toBeGreaterThan(0);
    const f = out[0]!;
    expect(f.title).toBe("Panchali Panchabhartruka");
    expect(f.releaseDate).toBe("2026-08-14");
    expect(f.language).toBe("Telugu");
    expect(f.foundIn).toEqual(["district"]);
    expect(f.sourceUrl).toContain("district.in");
  });

  it("the sweep is bounded — MAX_DETAIL_FETCHES caps the per-run cost", () => {
    expect(MAX_DETAIL_FETCHES).toBe(80);
    expect(parseListing(LISTING).length).toBeLessThanOrEqual(MAX_DETAIL_FETCHES);
  });

  it("REQUEST COUNT — one listing plus one detail per listed film", async () => {
    serve();
    await discoverDistrict(FROM, TO);
    expect(mockFetch).toHaveBeenCalledTimes(1 + parseListing(LISTING).length);
  });
});

describe("fail-safe / additive — the ENG-13 streak counter is wired", () => {
  it("a listing fetch failure degrades to [] and never throws", async () => {
    mockFetch.mockRejectedValue(new Error("District 503"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await expect(discoverDistrict(FROM, TO)).resolves.toEqual([]);
    expect(warn.mock.calls.some((c) => /consecutive failed attempts: 1/.test(String(c[0])))).toBe(true);
  });

  it("the streak escalates on repeated failure — the ENG-13 wording", async () => {
    mockFetch.mockRejectedValue(new Error("District 403"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await discoverDistrict(FROM, TO);
    expect(warn.mock.calls.some((c) => /is DEAD, not flaky/.test(String(c[0])))).toBe(true);
  });

  it("a listing that parses 0 links is a LOUD coverage warn, not silence", async () => {
    mockFetch.mockResolvedValue({ value: "<html>no links</html>", cached: false } as never);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await expect(discoverDistrict(FROM, TO)).resolves.toEqual([]);
    expect(warn.mock.calls.some((c) => /COVERAGE/.test(String(c[0])))).toBe(true);
  });

  it("ONE bad detail page never sinks the sweep", async () => {
    let n = 0;
    mockFetch.mockImplementation(async (key: string) => {
      if (String(key).includes(":listing")) return { value: LISTING, cached: false } as never;
      if (++n === 1) throw new Error("detail 500");
      return { value: PANCHALI, cached: false } as never;
    });
    const out = await discoverDistrict(FROM, TO);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("the existing theatrical nets are byte-unchanged", () => {
  it("District is theatrical-only — the OTT intent never calls it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/discovery/candidates.ts"), "utf8");
    const calls = [...src.matchAll(/discoverDistrict\(/g)];
    expect(calls).toHaveLength(1);
    const guard = src.indexOf('if (q.intent === "theatrical")');
    expect(guard).toBeGreaterThan(-1);
    expect(calls[0]!.index).toBeGreaterThan(guard);
  });

  it("the TMDb and Wikipedia net modules are untouched by this packet", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["src/discovery/sources/tmdbDiscover.ts", "src/discovery/sources/wikipediaList.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toContain("district");
    }
  });
});
