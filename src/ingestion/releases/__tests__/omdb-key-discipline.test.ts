// WD-ENG-10 PART 3 — OMDb refuses to fire without a real-shaped key.
//
// omdb.ts was the ONLY client that called out unconditionally. TMDb throws a
// named error when its key is unset; MDBList short-circuits with a log line and
// returns null. OMDb did neither — it handed whatever config.OMDB_API_KEY held
// straight to ofetch with `retry: 2`, so a placeholder meant THREE doomed
// round-trips to a third party per film, each 401, each swallowed by its catch.
// With the fake key "test" that ran on every suite run for weeks (WD-ENG-04).
//
// This is correct regardless of tests: burning retries and someone else's rate
// limit on a credential we can already see is wrong is not resilience.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ key: "test" as string | undefined, fetches: [] as string[] }));

vi.mock("../../../shared/config.js", () => ({
  config: {
    get OMDB_API_KEY() { return h.key; },
    TMDB_API_KEY: "x", NOTION_TOKEN: "x", MDBLIST_API_KEY: "",
  },
}));
// The cache is a pass-through so the loader actually runs — otherwise a cache
// hit would mask whether a request was attempted at all.
vi.mock("../../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));
// Records any attempt. The suite-wide network guard would ALSO block a real
// call, but this makes "was a request attempted" directly observable.
vi.mock("ofetch", () => ({
  ofetch: vi.fn(async (url: string) => { h.fetches.push(String(url)); return { Response: "True", Title: "X" }; }),
}));

const { fetchOmdbByImdbId, isPlaceholderOmdbKey, __resetOmdbKeyWarning } =
  await import("../omdb.js");

beforeEach(() => {
  h.fetches = [];
  __resetOmdbKeyWarning();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("isPlaceholderOmdbKey", () => {
  it.each(["test", "TEST", " test ", "changeme", "placeholder", "dummy", "fake", "none", "todo", "your_key_here", "", "   "])(
    "%s is a placeholder", (k) => expect(isPlaceholderOmdbKey(k)).toBe(true)
  );

  it("undefined is a placeholder", () => {
    expect(isPlaceholderOmdbKey(undefined)).toBe(true);
  });

  it.each(["a1b2c3d4", "9f8e7d6c", "trailer99"])("%s is treated as REAL", (k) => {
    // Exact list, not a shape heuristic: a length/charset rule would silently
    // disable ratings for everyone the day OMDb changes key format. The only
    // error this design can make is letting a weird REAL key through.
    expect(isPlaceholderOmdbKey(k)).toBe(false);
  });
});

describe("a placeholder key short-circuits with NO request attempted", () => {
  it.each(["test", "changeme", "", "   "])("key %j → null, zero fetches", async (key) => {
    h.key = key;
    const out = await fetchOmdbByImdbId("tt29330744");
    expect(out).toBeNull();
    expect(h.fetches).toEqual([]);          // THE POINT: nothing left the process
  });

  it("undefined key → null, zero fetches", async () => {
    h.key = undefined;
    expect(await fetchOmdbByImdbId("tt29330744")).toBeNull();
    expect(h.fetches).toEqual([]);
  });

  it("no retries are burned — the old path made 3 attempts per film", async () => {
    h.key = "test";
    for (const id of ["tt1", "tt2", "tt3", "tt4", "tt5", "tt6", "tt7"]) await fetchOmdbByImdbId(id);
    expect(h.fetches).toEqual([]);          // was ~21 requests to omdbapi.com
  });

  it("warns ONCE per process, not once per film (mirrors MDBList)", async () => {
    const warn = vi.fn();
    const { log } = await import("../../../shared/logger.js");
    vi.spyOn(log, "warn").mockImplementation(warn);
    h.key = "test";
    await fetchOmdbByImdbId("tt1");
    await fetchOmdbByImdbId("tt2");
    await fetchOmdbByImdbId("tt3");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("OMDB_API_KEY is missing or a placeholder");
    expect(String(warn.mock.calls[0]![0])).toContain("No request was attempted");
  });
});

describe("a REAL key is unaffected — production path byte-unchanged", () => {
  it("fires exactly one request and returns parsed data", async () => {
    h.key = "a1b2c3d4";
    const out = await fetchOmdbByImdbId("tt29330744");
    expect(h.fetches).toHaveLength(1);
    expect(out).not.toBeNull();
    expect(out!.imdbId).toBe("tt29330744");
  });

  it("no warn is emitted for a real key", async () => {
    const warn = vi.fn();
    const { log } = await import("../../../shared/logger.js");
    vi.spyOn(log, "warn").mockImplementation(warn);
    h.key = "a1b2c3d4";
    await fetchOmdbByImdbId("tt1");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("SCOPE — no other client's behaviour changed", () => {
  it("the short-circuit lives in omdb.ts only", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of ["src/ingestion/releases/tmdb.ts", "src/ingestion/ratings/mdblist.ts", "src/discovery/sources/wikipediaList.ts"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8")).not.toContain("isPlaceholderOmdbKey");
    }
  });
});
