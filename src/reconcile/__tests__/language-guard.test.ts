// WD-ENG-06 — the ai-net language guard. UNKNOWN IS NOT FOREIGN, and one TMDb
// field is not a verdict.
//
// ── WHAT ACTUALLY HAPPENED (diagnosed before this file was written) ─────────
// Agadha is a Telugu film opening 2026-08-14. It sits in the List of Telugu
// films of 2026 under day 14, TBSI named it in its own first comment, and TMDb's
// record for it (id 1747034) reads:
//
//     original_language: "en"        ← provisional stub on a brand-new record
//     origin_country:    ["IN"]      ← India, stated by the same record
//     production_countries: []       spoken_languages: []
//
// The guard read the first line, rejected on it as "non-Indian-language", and
// never reached the country gate two lines below that would have passed it.
// The gate fail-OPENS on missing country data by explicit design ("TMDb gaps
// must not eat a real Indian film"); the language check fail-CLOSED on the least
// reliable field in the record.
//
// NOTE the diagnosis corrected a plausible prior: NONE of the six rejections in
// the Aug-13 run had a missing language code — every one carried a confident
// ISO. So "unknown condemned by default" was a real latent bug (fixed and pinned
// below) but it is NOT what cost Agadha its slot.
//
// Fixtures are the real Aug-13 values; the wiki signal is driven by the frozen
// 2026 list pages captured under fixtures/wikipedia/lists-2026 (no network).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { reconcile, type ReconcileDeps } from "../reconcile.js";
import { buildWikiLanguageIndex, wikiLanguageFor } from "../../discovery/sources/wikiLanguageIndex.js";
import type { ExtractedFilm } from "../types.js";
import type { BucketWindow } from "../../shared/post-validator.js";
import type { TmdbTitleHit, TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";
import type { CountryFields } from "../../shared/country-gate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTS = join(HERE, "..", "..", "discovery", "__tests__", "fixtures", "wikipedia", "lists-2026");
const listHtml = (lang: string) => readFileSync(join(LISTS, `${lang.toLowerCase()}-2026.html`), "utf8");

const THEA: BucketWindow = { start: "2026-08-12", end: "2026-08-16", dateField: "theatrical", label: "In Theaters" };

const ai = (title: string, language?: string): ExtractedFilm => ({
  title, isSeries: false, date: "2026-08-14",
  ...(language ? { language } : {}),
  sources: [{ url: `https://press.example/${encodeURIComponent(title)}` }],
});

/** deps whose search returns ONE movie hit and whose credits carry countries. */
function deps(hits: Record<string, TmdbTitleHit>, countries: Record<number, CountryFields>): ReconcileDeps {
  return {
    searchTitle: async (title): Promise<TmdbTitleSearch> =>
      hits[title] ? { movie: [hits[title]!], tv: [] } : { movie: [], tv: [] },
    fetchCredits: async (id) => ({ leadCast: [], ...(countries[id] ? { countries: countries[id]! } : {}) }),
  };
}

const run = (
  titles: string[],
  hits: Record<string, TmdbTitleHit>,
  countries: Record<number, CountryFields>,
  wikiLanguageIndex?: ReadonlyMap<string, string>
) =>
  reconcile(
    {
      pillar: "theatrical", tmdbPool: [], aiFilms: titles.map((t) => ai(t)), window: THEA,
      ...(wikiLanguageIndex ? { wikiLanguageIndex } : {}),
    },
    deps(hits, countries)
  );

const rejectionFor = (r: Awaited<ReturnType<typeof reconcile>>, title: string) =>
  r.rejected.find((x) => x.title === title);

// ── The six Aug-13 records, verbatim ────────────────────────────────────────
const HITS: Record<string, TmdbTitleHit> = {
  "Agadha":                                { id: 1747034, title: "Agadha", originalLanguage: "en", releaseDate: "2026-08-14", year: 2026 },
  "Flag":                                  { id: 662712,  title: "Flag", originalLanguage: "ku", releaseDate: "2026-08-14", year: 2026 },
  "The End of Oak Street":                 { id: 1101383, title: "The End of Oak Street", originalLanguage: "en", releaseDate: "2026-08-14", year: 2026 },
  "My Best Friend, His Girlfriend and Me": { id: 1589248, title: "My Best Friend, His Girlfriend and Me", originalLanguage: "de", releaseDate: "2026-08-14", year: 2026 },
  "The Last Trip":                         { id: 481996,  title: "The Last Trip", originalLanguage: "he", releaseDate: "2026-08-14", year: 2026 },
  "Don't Say Good Luck":                   { id: 1504358, title: "Don't Say Good Luck", originalLanguage: "en", releaseDate: "2026-08-14", year: 2026 },
};
const COUNTRIES: Record<number, CountryFields> = {
  1747034: { origin_country: ["IN"], production_countries: [] },          // Agadha — INDIA, per TMDb
  1101383: { origin_country: ["US"], production_countries: [{ iso_3166_1: "US" }] },
  1589248: { origin_country: ["DE"], production_countries: [{ iso_3166_1: "DE" }] },
  1504358: { origin_country: ["US"], production_countries: [{ iso_3166_1: "US" }] },
  // Flag (ku) and The Last Trip (he) had no country detail cached — the gate's
  // fail-open path. They must STILL reject, on their language, not be rescued.
};

describe("AGADHA — the film the guard should never have rejected", () => {
  it("is NOT rejected as non-Indian-language", async () => {
    const r = await run(["Agadha"], HITS, COUNTRIES);
    expect(rejectionFor(r, "Agadha")).toBeUndefined();
    expect(r.rejected.map((x) => x.reason)).not.toContain("non-Indian-language");
  });

  it("becomes a reconciled candidate — TMDb's own origin_country ['IN'] is the evidence", async () => {
    const r = await run(["Agadha"], HITS, COUNTRIES);
    const f = r.reconciled.find((x) => x.title === "Agadha");
    expect(f, "Agadha must reach the reconciled list").toBeDefined();
    expect(f!.tmdbId).toBe(1747034);
    expect(f!.foundIn).toEqual(["ai-net"]);
  });

  it("the Wikipedia list rescues it too, on its own — with no country data at all", async () => {
    // Strip the country evidence entirely: the wiki signal must be sufficient by
    // itself, which is what makes it worth plumbing.
    const index = buildWikiLanguageIndex([{ language: "Telugu", year: 2026, html: listHtml("Telugu") }]);
    expect(wikiLanguageFor(index, "Agadha")).toBe("Telugu");

    const r = await run(["Agadha"], HITS, {}, index);
    expect(rejectionFor(r, "Agadha")).toBeUndefined();
    expect(r.reconciled.map((x) => x.title)).toContain("Agadha");
  });

  it("WITHOUT either signal it would still reject — the fix is evidence, not a blanket pass", async () => {
    // Same provisional "en", but nothing anywhere corroborates India.
    const r = await run(["Agadha"], HITS, {});
    expect(rejectionFor(r, "Agadha")?.reason).toBe("non-Indian-language");
  });
});

describe("THE GUARD DID NOT GO SOFT — genuinely foreign films reject, same label", () => {
  it.each([
    ["Flag", "ku"],
    ["The End of Oak Street", "en"],
    ["My Best Friend, His Girlfriend and Me", "de"],
    ["The Last Trip", "he"],
    ["Don't Say Good Luck", "en"],
  ])("%s (%s) still rejects as non-Indian-language", async (title) => {
    const r = await run([title], HITS, COUNTRIES);
    const rej = rejectionFor(r, title);
    expect(rej, `${title} must still be rejected`).toBeDefined();
    expect(rej!.reason).toBe("non-Indian-language");
    expect(r.reconciled.map((x) => x.title)).not.toContain(title);
  });

  it("all five reject in ONE pass while Agadha survives the same pass", async () => {
    const r = await run(Object.keys(HITS), HITS, COUNTRIES);
    expect(r.rejected.filter((x) => x.reason === "non-Indian-language").map((x) => x.title).sort()).toEqual([
      "Don't Say Good Luck", "Flag", "My Best Friend, His Girlfriend and Me",
      "The End of Oak Street", "The Last Trip",
    ]);
    expect(r.reconciled.map((x) => x.title)).toEqual(["Agadha"]);
  });

  it("a foreign film is NOT rescued by a wiki index that does not name it", async () => {
    const index = buildWikiLanguageIndex([{ language: "Telugu", year: 2026, html: listHtml("Telugu") }]);
    const r = await run(["My Best Friend, His Girlfriend and Me"], HITS, COUNTRIES, index);
    expect(rejectionFor(r, "My Best Friend, His Girlfriend and Me")?.reason).toBe("non-Indian-language");
  });

  it("a PILLAR-language film from a foreign country still rejects on COUNTRY, unchanged", async () => {
    // The Mastul class: the language check passes and the country check fails.
    // Note the code uses a PILLAR language ("ta"), not Bengali: INDIAN_LANG_CODES
    // is the seven pillar codes {te,ta,ml,hi,kn,mr,pa} and deliberately excludes
    // "bn", so a Bengali film rejects on LANGUAGE before the country gate is
    // reached. (The comment above this branch in reconcile.ts still describes
    // Mastul as passing a bn-shaped language check — stale, and flagged, not
    // changed: it is out of this packet's scope.)
    const hits = { Mastul: { id: 900, title: "Mastul", originalLanguage: "ta", releaseDate: "2026-08-14", year: 2026 } };
    const r = await run(["Mastul"], hits, { 900: { origin_country: ["BD"], production_countries: [{ iso_3166_1: "BD" }] } });
    expect(rejectionFor(r, "Mastul")?.reason).toMatch(/^non-Indian-country \[BD\]$/);
  });

  it("a Bengali film rejects on LANGUAGE — bn is not a pillar code (documented, unchanged)", async () => {
    const hits = { Bengali1: { id: 901, title: "Bengali1", originalLanguage: "bn", releaseDate: "2026-08-14", year: 2026 } };
    const r = await run(["Bengali1"], hits, { 901: { origin_country: ["BD"], production_countries: [{ iso_3166_1: "BD" }] } });
    expect(rejectionFor(r, "Bengali1")?.reason).toBe("non-Indian-language");
  });
});

describe("UNKNOWN IS NOT FOREIGN — the latent bug, now pinned", () => {
  const NO_LANG: Record<string, TmdbTitleHit> = {
    "Mystery Film": { id: 7001, title: "Mystery Film", releaseDate: "2026-08-14", year: 2026 },   // no originalLanguage
  };

  it("a film with NO language code, absent from every wiki list, is NOT called non-Indian", async () => {
    const index = buildWikiLanguageIndex([
      { language: "Telugu", year: 2026, html: listHtml("Telugu") },
      { language: "Kannada", year: 2026, html: listHtml("Kannada") },
    ]);
    expect(wikiLanguageFor(index, "Mystery Film")).toBeUndefined();

    const r = await run(["Mystery Film"], NO_LANG, {}, index);
    const rej = rejectionFor(r, "Mystery Film");
    expect(rej).toBeDefined();
    expect(rej!.reason).toBe("language unresolved");          // the honest label
    expect(rej!.reason).not.toBe("non-Indian-language");
  });

  it("the unresolved reject carries its source so the review can audit it", async () => {
    const r = await run(["Mystery Film"], NO_LANG, {});
    expect(rejectionFor(r, "Mystery Film")?.sourceUrl).toContain("press.example");
  });

  it("…but a missing code WITH India stated still becomes a candidate", async () => {
    const r = await run(["Mystery Film"], NO_LANG, { 7001: { origin_country: ["IN"], production_countries: [] } });
    expect(rejectionFor(r, "Mystery Film")).toBeUndefined();
    expect(r.reconciled.map((x) => x.title)).toContain("Mystery Film");
  });

  it("EMPTY country data does not rescue anything — fail-open is not an endorsement", async () => {
    // isIndianFilm fail-OPENS on no data (ok:true, present:false). If the guard
    // read `ok` alone, every unknown would sail through. It requires `present`.
    const r = await run(["Mystery Film"], NO_LANG, { 7001: { origin_country: [], production_countries: [] } });
    expect(rejectionFor(r, "Mystery Film")?.reason).toBe("language unresolved");
  });
});

describe("THE WIKI LANGUAGE SIGNAL — pinned against the frozen 2026 pages", () => {
  const index = buildWikiLanguageIndex([
    { language: "Telugu", year: 2026, html: listHtml("Telugu") },
    { language: "Kannada", year: 2026, html: listHtml("Kannada") },
    { language: "Malayalam", year: 2026, html: listHtml("Malayalam") },
  ]);

  it("indexes the whole year, not the query window", () => {
    // Agadha (August) and a January title must BOTH be present — a window-scoped
    // index would lose exactly the provisional records that need the signal.
    expect(index.size).toBeGreaterThan(400);
    expect(wikiLanguageFor(index, "Agadha")).toBe("Telugu");
    expect(wikiLanguageFor(index, "Toxic")).toBe("Kannada");
  });

  it("matches on the SAME normalization the discovery union uses", () => {
    expect(wikiLanguageFor(index, "  agadha  ")).toBe("Telugu");
    expect(wikiLanguageFor(index, "AGADHA")).toBe("Telugu");
  });

  it("returns undefined for a title no list names", () => {
    expect(wikiLanguageFor(index, "The End of Oak Street")).toBeUndefined();
    expect(wikiLanguageFor(index, "September 21")).toBeUndefined();   // TMDb-only, per ENG-05
  });

  it("an absent or empty index is inert — omitting it is exactly today's behaviour", () => {
    expect(wikiLanguageFor(undefined, "Agadha")).toBeUndefined();
    expect(wikiLanguageFor(new Map(), "Agadha")).toBeUndefined();
  });

  it("an empty page contributes nothing (Punjabi 2026 has no list)", () => {
    expect(buildWikiLanguageIndex([{ language: "Punjabi", year: 2026, html: "" }]).size).toBe(0);
  });
});

describe("POOL FILMS ARE STILL NEVER TOUCHED BY THIS GUARD", () => {
  it("a TMDb-pool film with a foreign language code is untouched (Indian by construction)", async () => {
    const r = await reconcile(
      {
        pillar: "theatrical",
        tmdbPool: [{
          id: "tmdb-1747034", tmdbId: 1747034, title: "Agadha", language: "Telugu", isSeries: false,
          platform: [], releaseDate: "2026-08-14", releaseDates: { theatrical: "2026-08-14" },
          genre: [], cast: [], synopsis: "", subtitleLanguages: [], sources: ["tmdb"],
          fetchedAt: "2026-08-13T00:00:00.000Z",
        }],
        aiFilms: [ai("Agadha")], window: THEA,
      },
      deps(HITS, COUNTRIES)
    );
    expect(r.rejected.map((x) => x.title)).not.toContain("Agadha");
    expect(r.reconciled.find((x) => x.title === "Agadha")!.foundIn.sort()).toEqual(["ai-net", "tmdb"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WD-ENG-07 — THE INDEX IS NOW CONSUMED FOR THE LANGUAGE ITSELF, not just for
// the Indian/foreign question. languageForCode maps any unrecognised ISO to the
// "Other" placeholder, and "Other" reaches the card's language row as such.
// Agadha's TMDb code is the provisional "en", so it landed on "Other" while the
// List of Telugu films of 2026 had been saying Telugu the whole time.
describe("WD-ENG-07 — a film whose language would be 'Other' takes the index's", () => {
  const telugu = () =>
    buildWikiLanguageIndex([{ language: "Telugu", year: 2026, html: listHtml("Telugu") }]);

  it("AGADHA: 'Other' becomes Telugu when the index knows it", async () => {
    const r = await run(["Agadha"], HITS, COUNTRIES, telugu());
    const f = r.reconciled.find((x) => x.title === "Agadha")!;
    expect(f.release?.language).toBe("Telugu");
    expect(f.release?.language).not.toBe("Other");
  });

  it("INDEX ABSENT ⇒ byte-identical to before — still 'Other', nothing invented", async () => {
    const r = await run(["Agadha"], HITS, COUNTRIES);
    const f = r.reconciled.find((x) => x.title === "Agadha")!;
    expect(f.release?.language).toBe("Other");
  });

  it("EMPTY index is equally inert", async () => {
    const r = await run(["Agadha"], HITS, COUNTRIES, new Map());
    expect(r.reconciled.find((x) => x.title === "Agadha")!.release?.language).toBe("Other");
  });

  it("a RESOLVED language is never overwritten by the index", async () => {
    // TMDb says Tamil ("ta"); the Telugu list also happens to name the title.
    // The resolved code wins — Wikipedia is the fallback authority here, not the
    // primary one. (Kattalan is a real Malayalam title; the point is the CODE.)
    const hits = { Agadha: { id: 1747034, title: "Agadha", originalLanguage: "ta", releaseDate: "2026-08-14", year: 2026 } };
    const r = await run(["Agadha"], hits, { 1747034: { origin_country: ["IN"], production_countries: [] } }, telugu());
    expect(r.reconciled.find((x) => x.title === "Agadha")!.release?.language).toBe("Tamil");
  });

  it("a title the index does not know keeps 'Other' — no guessing", async () => {
    const hits = { Unknown1: { id: 8080, title: "Unknown1", originalLanguage: "en", releaseDate: "2026-08-14", year: 2026 } };
    const r = await run(["Unknown1"], hits, { 8080: { origin_country: ["IN"], production_countries: [] } }, telugu());
    expect(r.reconciled.find((x) => x.title === "Unknown1")!.release?.language).toBe("Other");
  });
});
