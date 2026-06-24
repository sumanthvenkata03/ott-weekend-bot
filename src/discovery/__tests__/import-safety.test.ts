// import-safety.test.ts — the regression lock that keeps src/discovery importable
// with ZERO required env vars set. discover() pulls in tmdbDiscover -> tmdb.ts,
// which USED to import the eager shared/config (process.exit at module load on any
// missing key — OMDB/NOTION/R2, none of which discovery uses). tmdb.ts now reads
// TMDB_API_KEY from process.env at CALL time, so importing the module must be a
// pure, side-effect-free operation that never exits and never throws.
//
// CRITICAL: this file mocks ONLY cache.js (to stay off SQLite/FS) and ofetch (to
// stay off the network). It deliberately does NOT mock ../../ingestion/releases/
// tmdb.js — mocking that module is exactly what hid the import-time process.exit
// from the rest of the suite. We need the REAL module in the import graph here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("ofetch", () => ({ ofetch: vi.fn() }));
vi.mock("../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
}));

// Keys config.ts marks required (z.string().min(1)) and would process.exit on if
// eager config were still in discovery's import chain. NONE are used by discovery.
const REQUIRED_KEYS = [
  "TMDB_API_KEY",
  "OMDB_API_KEY",
  "NOTION_TOKEN",
  "NOTION_RELEASES_DB_ID",
  "NOTION_NEWS_DB_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of REQUIRED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of REQUIRED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("src/discovery import-safety", () => {
  it("🔒 imports discover() with ALL required env vars UNSET — no process.exit, no throw at import", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called at import time`);
      }) as never);

    const mod = await import("../index.js");

    expect(typeof mod.discover).toBe("function");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("🔒 TMDB_API_KEY is enforced at CALL time, not import time — a TMDb fetch throws the clear error", async () => {
    // The module imported cleanly above with the key unset. Now exercise the
    // fetch path itself: with TMDB_API_KEY still unset, the CALL — not the
    // import — must throw "TMDB_API_KEY is not set". (cache.js is a pass-through
    // mock, so the loader runs and surfaces the throw.)
    const { tmdbFetchCached } = await import("../../ingestion/releases/tmdb.js");
    await expect(tmdbFetchCached("/discover/movie", {}, 60)).rejects.toThrow("TMDB_API_KEY is not set");
  });
});
