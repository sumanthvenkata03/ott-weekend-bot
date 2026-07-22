// COUNTRY GATE · SEAM (b) — reconcile's NEW-movie guard (AI-net finds).
// TMDb access is injected exactly as reconcile.test.ts does it, so this suite
// touches no network, no key and no LLM.
import { describe, it, expect, vi, afterEach } from "vitest";
import { reconcile, type ReconcileDeps } from "../reconcile.js";
import { log } from "../../shared/logger.js";
import type { ExtractedFilm } from "../types.js";
import type { Release } from "../../shared/types.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";
import type { CountryFields } from "../../shared/country-gate.js";
import {
  ABSENT_COUNTRY,
  MASTUL_COUNTRY,
  MASTUL_TITLE,
  MASTUL_TMDB_ID,
  PUNJABI_INDIA_PAKISTAN,
  TAMIL_INDIA_SRILANKA,
  VARAVU_COUNTRY,
  VARAVU_TMDB_ID,
} from "../../shared/__fixtures__/tmdb-country.js";

const WIN: BucketWindow = { start: "2026-07-13", end: "2026-07-19", dateField: "ott", label: "Now Streaming" };

const ai = (title: string, language: string): ExtractedFilm => ({
  title, language, isSeries: false,
  sources: [{ url: `https://news.example/${encodeURIComponent(title)}` }],
});

/**
 * Deps whose fetchCredits returns country fields — mirroring the LIVE wiring,
 * where both come off the same /movie/{id} response (so seam (b) is free).
 */
function deps(
  search: Record<string, TmdbTitleSearch>,
  countryMap: Record<number, CountryFields> = {}
): ReconcileDeps {
  return {
    searchTitle: async (title) => search[title] ?? { movie: [], tv: [] },
    fetchCredits: async (id) => ({
      leadCast: [],
      ...(countryMap[id] ? { countries: countryMap[id]! } : {}),
    }),
  };
}

afterEach(() => vi.restoreAllMocks());
const captureLog = () => {
  const spy = vi.spyOn(log, "info").mockImplementation(() => {});
  return () => spy.mock.calls.map((c) => String(c[0]));
};

// Mastul's REAL shape: a bn-language film that passes the language guard.
const mastulSearch: Record<string, TmdbTitleSearch> = {
  [MASTUL_TITLE]: {
    movie: [{ id: MASTUL_TMDB_ID, title: MASTUL_TITLE, year: 2026, originalLanguage: "bn", posterPath: "/m.jpg" }],
    tv: [],
  },
};

describe("seam (b) — a non-Indian AI-net find is rejected, not tiered", () => {
  it("THE CASE — Mastul never becomes a reconciled film", async () => {
    captureLog();
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai(MASTUL_TITLE, "Bengali")], window: WIN },
      deps(mastulSearch, { [MASTUL_TMDB_ID]: MASTUL_COUNTRY })
    );
    expect(r.reconciled).toHaveLength(0);
    expect(r.rejected.find((x) => x.title === MASTUL_TITLE)).toBeDefined();
  });

  it("Mastul is caught by the LANGUAGE guard here, now that bn is gone", async () => {
    // Honest assertion of the ACTUAL path. After the bn cleanup, Mastul's
    // original_language "bn" is no longer an admission ticket, so the language
    // guard rejects it before the country gate is ever consulted at THIS seam.
    // That is defence in depth working, not the country gate being redundant —
    // see the Pakistani-Punjabi case below, which ONLY the country gate catches.
    captureLog();
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai(MASTUL_TITLE, "Bengali")], window: WIN },
      deps(mastulSearch, { [MASTUL_TMDB_ID]: MASTUL_COUNTRY })
    );
    expect(r.rejected.find((x) => x.title === MASTUL_TITLE)!.reason).toBe("non-Indian-language");
  });

  it("THE COUNTRY-ONLY CASE — a Pakistani Punjabi film passes the language guard and the country gate stops it", async () => {
    // "pa" IS one of our seven, so the language guard admits this film. Only the
    // country gate can tell Pollywood (IN) from Lollywood (PK). This is the case
    // that would still be broken if we had shipped the bn cleanup alone.
    const lines = captureLog();
    const search: Record<string, TmdbTitleSearch> = {
      "Lahore Nights": { movie: [{ id: 301, title: "Lahore Nights", year: 2026, originalLanguage: "pa" }], tv: [] },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai("Lahore Nights", "Punjabi")], window: WIN },
      deps(search, { 301: { origin_country: ["PK"], production_countries: [{ iso_3166_1: "PK", name: "Pakistan" }] } })
    );
    expect(r.reconciled).toHaveLength(0);

    // DISTINCT reason — collapsing it into non-Indian-language would hide the class.
    const rej = r.rejected.find((x) => x.title === "Lahore Nights")!;
    expect(rej.reason).toContain("non-Indian-country");
    expect(rej.reason).not.toBe("non-Indian-language");
    expect(rej.reason).toContain("PK");

    // …and it is LOGGED, never silent.
    const line = lines().find((l) => l.includes("country-gate/reconcile") && l.includes("REJECT"));
    expect(line).toBeDefined();
    expect(line).toContain("301");
    expect(line).toContain("[PK]");
  });

  it("the language guard fires FIRST for a genuinely foreign-language find", async () => {
    // A Korean film is rejected on language before the country gate is consulted;
    // the two reasons stay separable in the review.
    captureLog();
    const search: Record<string, TmdbTitleSearch> = {
      "Some Korean Film": { movie: [{ id: 777, title: "Some Korean Film", year: 2026, originalLanguage: "ko" }], tv: [] },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai("Some Korean Film", "Korean")], window: WIN },
      deps(search, { 777: { origin_country: ["KR"] } })
    );
    expect(r.rejected.find((x) => x.title === "Some Korean Film")!.reason).toBe("non-Indian-language");
  });
});

describe("seam (b) — Indian finds survive", () => {
  it("a real Indian film is admitted", async () => {
    captureLog();
    const search: Record<string, TmdbTitleSearch> = {
      Varavu: { movie: [{ id: VARAVU_TMDB_ID, title: "Varavu", year: 2026, originalLanguage: "ml" }], tv: [] },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai("Varavu", "Malayalam")], window: WIN },
      deps(search, { [VARAVU_TMDB_ID]: VARAVU_COUNTRY })
    );
    expect(r.reconciled).toHaveLength(1);
    expect(r.reconciled[0]!.tmdbId).toBe(VARAVU_TMDB_ID);
  });

  it("co-productions survive — IN/PK and IN/LK", async () => {
    captureLog();
    const search: Record<string, TmdbTitleSearch> = {
      "Punjabi Co-Pro": { movie: [{ id: 201, title: "Punjabi Co-Pro", year: 2026, originalLanguage: "pa" }], tv: [] },
      "Tamil Co-Pro": { movie: [{ id: 202, title: "Tamil Co-Pro", year: 2026, originalLanguage: "ta" }], tv: [] },
    };
    const r = await reconcile(
      {
        pillar: "ott", tmdbPool: [],
        aiFilms: [ai("Punjabi Co-Pro", "Punjabi"), ai("Tamil Co-Pro", "Tamil")],
        window: WIN,
      },
      deps(search, { 201: PUNJABI_INDIA_PAKISTAN, 202: TAMIL_INDIA_SRILANKA })
    );
    expect(r.reconciled).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  it("absent country data passes WITH a ⚠ that is actually emitted", async () => {
    const lines = captureLog();
    const search: Record<string, TmdbTitleSearch> = {
      "Gap Film": { movie: [{ id: 203, title: "Gap Film", year: 2026, originalLanguage: "ta" }], tv: [] },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: [], aiFilms: [ai("Gap Film", "Tamil")], window: WIN },
      deps(search, { 203: ABSENT_COUNTRY })
    );
    expect(r.reconciled).toHaveLength(1);
    const warn = lines().find((l) => l.includes("country-gate/reconcile") && l.includes("⚠"));
    expect(warn).toBeDefined();
    expect(warn).toContain("Gap Film");
  });
});

describe("seam (b) — POOL films are never touched by the gate", () => {
  it("a pool film is not country-checked and never fetches credits", async () => {
    // Pool films come from the (now country-gated) discover path — re-gating them
    // here would double-charge, and a fetchCredits call for a pool film is itself
    // the bug this asserts against.
    captureLog();
    const pool: Release[] = [{
      id: "tmdb-9001", tmdbId: 9001, title: "Pool Film", language: "Tamil", isSeries: false,
      platform: [], releaseDate: "2026-07-15", releaseDates: { ott: "2026-07-15" },
      genre: [], cast: [], synopsis: "", subtitleLanguages: [], sources: ["tmdb"],
      fetchedAt: "2026-07-14T00:00:00.000Z",
    }];
    let credited = 0;
    const d: ReconcileDeps = {
      searchTitle: async () => ({
        movie: [{ id: 9001, title: "Pool Film", year: 2026, originalLanguage: "ta" }], tv: [],
      }),
      fetchCredits: async () => { credited++; return { leadCast: [] }; },
    };
    const r = await reconcile(
      { pillar: "ott", tmdbPool: pool, aiFilms: [ai("Pool Film", "Tamil")], window: WIN }, d
    );
    expect(credited).toBe(0);
    expect(r.reconciled).toHaveLength(1);
  });
});
