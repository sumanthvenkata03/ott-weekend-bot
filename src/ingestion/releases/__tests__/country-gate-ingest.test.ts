// COUNTRY GATE · SEAM (a) — discover ingestion.
// applyCountryGate is pure (the country data was fetched upstream), so this
// suite touches no network, no key and no cache.
import { describe, it, expect, vi, afterEach } from "vitest";

// config + cache mocked so importing the ratings module never opens SQLite or
// hits config's import-time process.exit — the established pattern from
// discovery/__tests__/ott-candidates.test.ts. This is what makes the suite pass
// on a fresh clone with no .env.
vi.mock("../../../shared/config.js", () => ({
  config: { MDBLIST_API_KEY: "", OMDB_API_KEY: "test", TMDB_API_KEY: "test" },
}));
vi.mock("../../../shared/cache.js", () => ({
  cached: (_k: string, loader: () => unknown) => loader(),
  db: {},
  purgeExpired: vi.fn(),
  cacheStats: vi.fn(),
}));

import { applyCountryGate, type ReleaseWithCountry } from "../index.js";
import { log } from "../../../shared/logger.js";
import type { Release } from "../../../shared/types.js";
import {
  ABSENT_COUNTRY,
  MASTUL_COUNTRY,
  MASTUL_TITLE,
  MASTUL_TMDB_ID,
  PUNJABI_INDIA_PAKISTAN,
  TAMIL_INDIA_SRILANKA,
  VARAVU_COUNTRY,
  VARAVU_TITLE,
  VARAVU_TMDB_ID,
} from "../../../shared/__fixtures__/tmdb-country.js";

const release = (tmdbId: number, title: string): Release => ({
  id: `tmdb-${tmdbId}`,
  tmdbId,
  title,
  language: "Malayalam",
  isSeries: false,
  platform: [],
  releaseDate: "2026-07-17",
  genre: [],
  cast: [],
  synopsis: "",
  subtitleLanguages: [],
  sources: ["tmdb"],
  fetchedAt: "2026-07-17T00:00:00.000Z",
});

const MASTUL: ReleaseWithCountry = {
  release: release(MASTUL_TMDB_ID, MASTUL_TITLE),
  countries: MASTUL_COUNTRY,
};
const VARAVU: ReleaseWithCountry = {
  release: release(VARAVU_TMDB_ID, VARAVU_TITLE),
  countries: VARAVU_COUNTRY,
};

afterEach(() => vi.restoreAllMocks());

/** Capture everything the gate logs, as plain strings. */
function captureLog(): { lines: () => string[] } {
  const spy = vi.spyOn(log, "info").mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map((c) => String(c[0])) };
}

describe("seam (a) — the gate drops non-Indian films at ingest", () => {
  it("THE CASE — Mastul is rejected and never reaches the returned pool", () => {
    captureLog();
    const kept = applyCountryGate([MASTUL, VARAVU]);
    expect(kept.map((r) => r.tmdbId)).toEqual([VARAVU_TMDB_ID]);
  });

  it("a real Indian film survives", () => {
    captureLog();
    expect(applyCountryGate([VARAVU])).toHaveLength(1);
  });

  it("both co-production shapes survive", () => {
    captureLog();
    const kept = applyCountryGate([
      { release: release(101, "Punjabi Co-Pro"), countries: PUNJABI_INDIA_PAKISTAN },
      { release: release(102, "Tamil Co-Pro"), countries: TAMIL_INDIA_SRILANKA },
    ]);
    expect(kept).toHaveLength(2);
  });
});

describe("seam (a) — absent country data passes WITH a ⚠", () => {
  it("the film is kept", () => {
    captureLog();
    const kept = applyCountryGate([{ release: release(103, "Gap Film"), countries: ABSENT_COUNTRY }]);
    expect(kept).toHaveLength(1);
  });

  it("the ⚠ is ACTUALLY EMITTED, not merely implied", () => {
    const logged = captureLog();
    applyCountryGate([{ release: release(103, "Gap Film"), countries: ABSENT_COUNTRY }]);
    const warnLines = logged.lines().filter((l) => l.includes("⚠"));
    expect(warnLines.length).toBeGreaterThan(0);
    expect(warnLines.join("\n")).toContain("Gap Film");
  });

  it("a stub with no tmdbId (so no detail fetch happened) also passes with ⚠", () => {
    const logged = captureLog();
    const kept = applyCountryGate([{ release: release(104, "No Detail Fetch") }]);
    expect(kept).toHaveLength(1);
    expect(logged.lines().some((l) => l.includes("⚠"))).toBe(true);
  });
});

describe("seam (a) — no silent rejects", () => {
  it("the reject is logged with title, tmdbId and the full country set", () => {
    const logged = captureLog();
    applyCountryGate([MASTUL]);
    const rejectLine = logged.lines().find((l) => l.includes("REJECT"));
    expect(rejectLine).toBeDefined();
    expect(rejectLine).toContain(MASTUL_TITLE);
    expect(rejectLine).toContain(String(MASTUL_TMDB_ID));
    expect(rejectLine).toContain("[BD,DE,NL]");
  });

  it("passes are logged too — a silent pass and a missing film look identical otherwise", () => {
    const logged = captureLog();
    applyCountryGate([VARAVU]);
    expect(logged.lines().some((l) => l.includes("country-gate/ingest") && l.includes("pass"))).toBe(true);
  });

  it("emits a summary counting rejects and ⚠s", () => {
    const logged = captureLog();
    applyCountryGate([MASTUL, VARAVU, { release: release(105, "Gap"), countries: ABSENT_COUNTRY }]);
    const summary = logged.lines().find((l) => l.includes("kept"));
    expect(summary).toContain("1 rejected as non-Indian");
    expect(summary).toContain("1 passed with ⚠");
  });
});

describe("seam (a) — placement is load-bearing", () => {
  it("is a pure function over already-fetched data, so it can sit between steps 3 and 4", () => {
    // The gate makes no calls: that is what lets it run after the /movie/{id}
    // credits step (where country data first exists) and BEFORE the ratings step,
    // so a rejected film never costs an OMDb or MDBList request.
    captureLog();
    expect(applyCountryGate([])).toEqual([]);
    expect(applyCountryGate([MASTUL])).toEqual([]);
  });
});
