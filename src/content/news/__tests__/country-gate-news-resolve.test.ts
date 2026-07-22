// COUNTRY GATE · SEAM (c) — the news resolver.
//
// ZERO LIVE NETWORK. searchTitleTmdb is module-mocked and the country fetcher is
// injected, so the whole lane runs offline. This is the seam that stops a foreign
// film's poster from DRESSING A PUBLISHED CARD, which is why it is worth the one
// extra /movie/{id} call the live path makes.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const searchTitleTmdb = vi.fn();
vi.mock("../../../ingestion/releases/tmdb.js", () => ({
  searchTitleTmdb: (...a: unknown[]) => searchTitleTmdb(...a),
  posterUrl: (p: string | null) => (p ? `https://image.tmdb.org/t/p/w500${p}` : undefined),
  // Must exist for the module to import; the suite always injects instead, and
  // the throw makes an accidental live call fail loudly rather than hit TMDb.
  getMovieCountries: async () => { throw new Error("live network in a test"); },
}));

const { resolveStory, resolveStories } = await import("../news-resolve.js");
const { log } = await import("../../../shared/logger.js");
import type { VerifiedStory } from "../news-verify.js";
import type { ScoredCluster } from "../news-score.js";
import type { CountryFields } from "../../../shared/country-gate.js";
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

const WINDOW_YEAR = 2026;
const noJudged = () => null;

const cluster = (headline: string, language: string): ScoredCluster => ({
  id: "c1", headline, language, items: [], outlets: ["Cinema Express"], outletCount: 1,
  bestTier: "A", hasTierC: false, storyClass: "ott-date", classWeight: 3, suppressed: false,
  tierPoints: 3, crossOutletPoints: 0, judgedTitle: null, judgedPoints: 0, score: 9,
  eligible: true, holdReason: "",
} as unknown as ScoredCluster);

const story = (headline: string, language: string, filmTitle: string): VerifiedStory => ({
  cluster: cluster(headline, language),
  confirmed: true,
  sourceUrl: "https://cinemaexpress.com/story",
  basis: "outlet page names the film",
  films: [{ title: filmTitle, note: "gets an OTT date" }],
} as unknown as VerifiedStory);

/** Country fetcher stub — the ONLY country source in this suite. */
const countryFetcher = (map: Record<number, CountryFields>) => {
  const calls: number[] = [];
  const fn = async (id: number) => { calls.push(id); return map[id] ?? {}; };
  return { fn, calls: () => calls };
};

let logLines: () => string[];
beforeEach(() => {
  const spy = vi.spyOn(log, "info").mockImplementation(() => {});
  logLines = () => spy.mock.calls.map((c) => String(c[0]));
});
afterEach(() => { vi.restoreAllMocks(); searchTitleTmdb.mockReset(); });

describe("seam (c) — a foreign film never dresses a card", () => {
  beforeEach(() => {
    // Mastul's real search shape: the title matches EXACTLY and the year is in
    // range, so the sanity gate passes it. Only the country gate can stop it.
    searchTitleTmdb.mockResolvedValue({
      movie: [{
        id: MASTUL_TMDB_ID, title: MASTUL_TITLE, year: 2026,
        originalLanguage: "bn", posterPath: "/hRf9XtlZ6Ezt1GMmcYxHGFQEmqu.jpg",
        releaseDate: "2026-07-17",
      }],
      tv: [],
    });
  });

  it("THE CASE — Mastul resolves to NO film and carries NO poster", async () => {
    const cf = countryFetcher({ [MASTUL_TMDB_ID]: MASTUL_COUNTRY });
    const r = await resolveStory(
      story(`'${MASTUL_TITLE}' locks its OTT release`, "Bengali", MASTUL_TITLE),
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    // The page named it, so it still renders typographically — but with NO art.
    expect(r.film?.posterUrl).toBeUndefined();
    expect(r.film?.tmdbId).toBeUndefined();
    expect(r.films.every((f) => f.posterUrl === undefined)).toBe(true);
  });

  it("the sanity gate ALONE would have admitted it — proving the gate is load-bearing", async () => {
    // Same story, but the country fetcher reports India. The poster now attaches.
    const cf = countryFetcher({ [MASTUL_TMDB_ID]: VARAVU_COUNTRY });
    const r = await resolveStory(
      story(`'${MASTUL_TITLE}' locks its OTT release`, "Bengali", MASTUL_TITLE),
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    expect(r.film?.posterUrl).toContain("hRf9XtlZ6Ezt1GMmcYxHGFQEmqu");
  });

  it("the rejection is reported in the run-table reason and LOGGED", async () => {
    const cf = countryFetcher({ [MASTUL_TMDB_ID]: MASTUL_COUNTRY });
    const r = await resolveStory(
      story(`'${MASTUL_TITLE}' locks its OTT release`, "Bengali", MASTUL_TITLE),
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    expect(r.reason).toContain("REJECTED non-Indian country");
    expect(r.reason).toContain("BD");
    const line = logLines().find((l) => l.includes("country-gate/news-resolve") && l.includes("REJECT"));
    expect(line).toBeDefined();
    expect(line).toContain("[BD,DE,NL]");
  });

  it("fires only AFTER the sanity gate — a low-similarity hit costs no country call", async () => {
    // The Hulk case: "G.D.N" vs "Hulk and the Agents of S.M.A.S.H.". The cheap
    // deterministic check must reject first, so we never spend the extra request.
    searchTitleTmdb.mockResolvedValue({
      movie: [{ id: 999, title: "Hulk and the Agents of S.M.A.S.H.", year: 2026 }], tv: [],
    });
    const cf = countryFetcher({});
    const r = await resolveStory(story("'G.D.N' gets a date", "Telugu", "G.D.N"), [], noJudged, WINDOW_YEAR, cf.fn);
    expect(cf.calls()).toEqual([]);
    expect(r.reason).toContain("low-sim");
  });
});

describe("seam (c) — Indian films keep their art", () => {
  beforeEach(() => {
    searchTitleTmdb.mockResolvedValue({
      movie: [{ id: VARAVU_TMDB_ID, title: VARAVU_TITLE, year: 2026, originalLanguage: "ml", posterPath: "/varavu.jpg" }],
      tv: [],
    });
  });

  it("a real Indian film resolves WITH its poster", async () => {
    const cf = countryFetcher({ [VARAVU_TMDB_ID]: VARAVU_COUNTRY });
    const r = await resolveStory(
      story(`'${VARAVU_TITLE}' locks its OTT release`, "Malayalam", VARAVU_TITLE),
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    expect(r.film?.tmdbId).toBe(VARAVU_TMDB_ID);
    expect(r.film?.posterUrl).toContain("/varavu.jpg");
    expect(cf.calls()).toEqual([VARAVU_TMDB_ID]);
  });

  it("co-productions keep their art — IN/PK and IN/LK", async () => {
    for (const countries of [PUNJABI_INDIA_PAKISTAN, TAMIL_INDIA_SRILANKA]) {
      const cf = countryFetcher({ [VARAVU_TMDB_ID]: countries });
      const r = await resolveStory(
        story(`'${VARAVU_TITLE}' locks its OTT release`, "Punjabi", VARAVU_TITLE),
        [], noJudged, WINDOW_YEAR, cf.fn
      );
      expect(r.film?.posterUrl).toBeDefined();
    }
  });

  it("absent country data keeps the art and EMITS the ⚠, in the log AND the reason", async () => {
    const cf = countryFetcher({ [VARAVU_TMDB_ID]: ABSENT_COUNTRY });
    const r = await resolveStory(
      story(`'${VARAVU_TITLE}' locks its OTT release`, "Malayalam", VARAVU_TITLE),
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    expect(r.film?.posterUrl).toBeDefined();
    expect(r.reason).toContain("⚠ no country data");
    const warn = logLines().find((l) => l.includes("country-gate/news-resolve") && l.includes("⚠"));
    expect(warn).toBeDefined();
  });

  it("a country-fetch failure degrades to ⚠ pass, never to a silent drop", async () => {
    // getMovieCountries returns {} on error by design — the gate reads that as
    // the fail-open path, so a TMDb outage cannot quietly empty an edition.
    const r = await resolveStory(
      story(`'${VARAVU_TITLE}' locks its OTT release`, "Malayalam", VARAVU_TITLE),
      [], noJudged, WINDOW_YEAR, async () => ({})
    );
    expect(r.film?.posterUrl).toBeDefined();
    expect(r.reason).toContain("⚠");
  });
});

describe("seam (c) — wiring", () => {
  it("resolveStories threads the injected fetcher to every story", async () => {
    searchTitleTmdb.mockResolvedValue({
      movie: [{ id: VARAVU_TMDB_ID, title: VARAVU_TITLE, year: 2026, posterPath: "/v.jpg" }], tv: [],
    });
    const cf = countryFetcher({ [VARAVU_TMDB_ID]: MASTUL_COUNTRY });
    const out = await resolveStories(
      [
        story(`'${VARAVU_TITLE}' one`, "Malayalam", VARAVU_TITLE),
        story(`'${VARAVU_TITLE}' two`, "Malayalam", VARAVU_TITLE),
      ],
      [], noJudged, WINDOW_YEAR, cf.fn
    );
    expect(cf.calls()).toHaveLength(2);
    expect(out.every((r) => r.film?.posterUrl === undefined)).toBe(true);
  });
});
