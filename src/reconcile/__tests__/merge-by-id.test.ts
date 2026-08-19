// WD-ENG-20 — ONE TMDb ID IS ONE FILM.
//
// ── THE DEFECT THESE PINS CLOSE (live in gate b35c32ce6447) ─────────────────
// Three pairs in the Aug-19 theatrical deck each shared ONE tmdbId and differed
// only in spelling or language variant. Every dedupe upstream is TITLE-keyed, so
// each film held TWO green rows in the review the operator was asked to approve:
//
//   1685882  "Modha Rathri"    (tmdb+district)   vs "Modha Rathiri"    (wikipedia)
//   1036081  "Khalifa Part 1"  (tmdb)            vs "Khalifa"          (district)
//   1441228  "Irumudi" te      (tmdb+wiki+dist)  vs "Irumudi Kattu" ta (district)
//
// WED_DROP_EXCLUDE cannot fix this — both rows of a pair share the id it keys on.
//
// ── THE THREE PROPERTIES ────────────────────────────────────────────────────
//   1. tmdbId is the ONLY merge key. Titles never merge anything, so two films
//      with confusable titles and different ids stay two films.
//   2. The merged row is never WEAKER: provenance unions, so it counts at least
//      as many independent nets as either row it replaces.
//   3. Nothing without a tmdbId is touched — manual adds and TMDb-less finds
//      come back as the same objects. Pinned in both directions.
import { describe, it, expect } from "vitest";
import {
  mergeByTmdbId,
  pickCanonical,
  isTmdbNetFind,
  type MergeByIdReport,
} from "../merge-by-id.js";
import { reconcile, assignTier, type ReconcileDeps } from "../reconcile.js";
import { independentNetCount } from "../net-independence.js";
import { buildManualFilm } from "../manual-adds.js";
import type { ReconciledFilm } from "../types.js";
import type { Release } from "../../shared/types.js";
import type { BucketWindow } from "../../shared/post-validator.js";

// ── Fixtures: the real Aug-19 rows, field for field ─────────────────────────
function release(p: Partial<Release> & { id: string; title: string }): Release {
  return {
    language: "Tamil",
    isSeries: false,
    platform: [],
    releaseDate: "2026-08-21",
    genre: [],
    cast: [],
    synopsis: "",
    subtitleLanguages: [],
    sources: ["tmdb"],
    fetchedAt: "2026-08-18T00:00:00.000Z",
    ...p,
  };
}

function film(p: Partial<ReconciledFilm> & { title: string }): ReconciledFilm {
  return {
    language: "Tamil",
    pillar: "theatrical",
    date: "2026-08-21",
    dateSource: "tmdb",
    foundIn: ["tmdb"],
    status: "confirmed",
    landingStatus: "pass",
    tier: "yellow",
    reasons: [],
    ...p,
  } as ReconciledFilm;
}

/** 1685882 — TMDb's own record ("Modha Rathri") + the Wikipedia spelling. */
const MODHA_TMDB = film({
  tmdbId: 1685882, title: "Modha Rathri", language: "Tamil",
  foundIn: ["tmdb", "district", "ai-net"], resolvedTitle: "Modha Rathri",
  release: release({
    id: "tmdb-1685882", tmdbId: 1685882, title: "Modha Rathri", language: "Tamil",
    sources: ["tmdb", "district"], audioLanguages: { original: "Tamil" },
  }),
});
const MODHA_WIKI = film({
  tmdbId: 1685882, title: "Modha Rathiri", language: "Tamil",
  foundIn: ["wikipedia", "tmdb", "ai-net"], resolvedTitle: "Modha Rathiri",
  release: release({
    id: "tmdb-1685882", tmdbId: 1685882, title: "Modha Rathiri", language: "Tamil",
    sources: ["wikipedia"], audioLanguages: { original: "Tamil" },
  }),
});

/** 1441228 — the Telugu record and the Tamil version of the SAME film. */
const IRUMUDI_TE = film({
  tmdbId: 1441228, title: "Irumudi", language: "Telugu",
  foundIn: ["tmdb", "wikipedia", "district", "ai-net"], resolvedTitle: "Irumudi",
  release: release({
    id: "tmdb-1441228", tmdbId: 1441228, title: "Irumudi", language: "Telugu",
    sources: ["tmdb", "wikipedia", "district", "omdb"], audioLanguages: { original: "Telugu" },
  }),
});
const IRUMUDI_TA = film({
  tmdbId: 1441228, title: "Irumudi Kattu", language: "Tamil",
  foundIn: ["district", "tmdb", "ai-net"], resolvedTitle: "Irumudi Kattu",
  release: release({
    id: "tmdb-1441228", tmdbId: 1441228, title: "Irumudi Kattu", language: "Tamil",
    sources: ["district", "omdb"], audioLanguages: { original: "Tamil", dubbed: ["Telugu"] },
  }),
});

const only = (merges: MergeByIdReport[]): MergeByIdReport => {
  expect(merges).toHaveLength(1);
  return merges[0]!;
};

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 — the pairs collapse, and only on a SHARED tmdbId", () => {
  it("two rows carrying one tmdbId become ONE row", () => {
    const out = mergeByTmdbId([MODHA_TMDB, MODHA_WIKI]);
    expect(out.films).toHaveLength(1);
    expect(out.films[0]!.tmdbId).toBe(1685882);
    expect(out.merges).toHaveLength(1);
  });

  it("all three real Aug-19 pairs collapse in one pass, other rows untouched", () => {
    const other = film({ tmdbId: 1748479, title: "Harrd Disk", language: "Hindi", foundIn: ["tmdb", "wikipedia"] });
    const out = mergeByTmdbId([MODHA_TMDB, IRUMUDI_TE, other, MODHA_WIKI, IRUMUDI_TA]);
    expect(out.films).toHaveLength(3);
    expect(out.merges.map((m) => m.tmdbId).sort()).toEqual([1441228, 1685882]);
    // The untouched row is the SAME OBJECT, not a rebuilt copy.
    expect(out.films).toContain(other);
  });

  it("🔒 DIFFERENT ids never merge, however close the titles", () => {
    const a = film({ tmdbId: 111, title: "Vikalpa", language: "Telugu" });
    const b = film({ tmdbId: 222, title: "Vikalpa", language: "Kannada" });
    const out = mergeByTmdbId([a, b]);
    expect(out.films).toHaveLength(2);
    expect(out.merges).toHaveLength(0);
    // Untouched means untouched — no mergedVariants key appears anywhere.
    expect(out.films.every((f) => f.mergedVariants === undefined)).toBe(true);
  });

  it("a lone row for an id is returned as the SAME object", () => {
    const out = mergeByTmdbId([MODHA_TMDB]);
    expect(out.films[0]).toBe(MODHA_TMDB);
    expect(out.merges).toHaveLength(0);
  });

  it("the merged row takes the FIRST row's slot — deck order does not shuffle", () => {
    const first = film({ tmdbId: 900, title: "First" });
    const last = film({ tmdbId: 901, title: "Last" });
    const out = mergeByTmdbId([first, MODHA_TMDB, last, MODHA_WIKI]);
    expect(out.films.map((f) => f.title)).toEqual(["First", "Modha Rathri", "Last"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 — the kept row is TMDb's OWN record", () => {
  it("isTmdbNetFind reads DISCOVERY tags only — enrichment tags never qualify", () => {
    expect(isTmdbNetFind(MODHA_TMDB)).toBe(true);
    expect(isTmdbNetFind(MODHA_WIKI)).toBe(false);
    // omdb / tmdb-search are enrichment: they decorate a film, they never found one.
    const enrichedOnly = film({
      tmdbId: 5, title: "X",
      release: release({ id: "tmdb-5", title: "X", sources: ["district", "omdb", "tmdb-search"] }),
    });
    expect(isTmdbNetFind(enrichedOnly)).toBe(false);
  });

  it("title + language come from the TMDb-net row even when it is SECOND in the deck", () => {
    const out = mergeByTmdbId([MODHA_WIKI, MODHA_TMDB]);
    const kept = out.films[0]!;
    expect(kept.title).toBe("Modha Rathri");        // TMDb's spelling, not Wikipedia's
    expect(kept.release!.title).toBe("Modha Rathri");
    expect(kept.resolvedTitle).toBe("Modha Rathri");
  });

  it("the Telugu record wins over the Tamil version — language is TMDb's", () => {
    const out = mergeByTmdbId([IRUMUDI_TA, IRUMUDI_TE]);
    expect(out.films[0]!.title).toBe("Irumudi");
    expect(out.films[0]!.language).toBe("Telugu");
  });

  it("with NO TMDb-net row in the group, the first row wins — deterministic, never arbitrary", () => {
    const a = film({ tmdbId: 77, title: "A", release: release({ id: "tmdb-77", title: "A", sources: ["district"] }) });
    const b = film({ tmdbId: 77, title: "B", release: release({ id: "tmdb-77", title: "B", sources: ["wikipedia"] }) });
    expect(pickCanonical([a, b])).toBe(a);
    expect(pickCanonical([b, a])).toBe(b);
  });

  it("the folded rows are NAMED on the merged row, so nothing vanishes silently", () => {
    const kept = mergeByTmdbId([IRUMUDI_TE, IRUMUDI_TA]).films[0]!;
    expect(kept.mergedVariants).toEqual([
      { title: "Irumudi Kattu", language: "Tamil", foundIn: ["district", "tmdb", "ai-net"] },
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — the merged row is STRONGER, never weaker", () => {
  it("foundIn is the UNION, canonical's tags first", () => {
    const m = only(mergeByTmdbId([MODHA_TMDB, MODHA_WIKI]).merges);
    expect(m.foundIn).toEqual(["tmdb", "district", "ai-net", "wikipedia"]);
  });

  it("🔒 the merged row counts AT LEAST as many independent nets as either row", () => {
    for (const pair of [[MODHA_TMDB, MODHA_WIKI], [IRUMUDI_TE, IRUMUDI_TA]]) {
      const kept = mergeByTmdbId(pair).films[0]!;
      const before = Math.max(...pair.map((f) => independentNetCount(f.foundIn)));
      expect(independentNetCount(kept.foundIn)).toBeGreaterThanOrEqual(before);
    }
  });

  it("two single-net rows on DIFFERENT classes merge to a corroborated (green) row", () => {
    const a = film({
      tmdbId: 42, title: "Solo A", foundIn: ["tmdb"],
      release: release({ id: "tmdb-42", title: "Solo A", sources: ["tmdb"] }),
    });
    const b = film({
      tmdbId: 42, title: "Solo B", foundIn: ["district"],
      release: release({ id: "tmdb-42", title: "Solo B", sources: ["district"] }),
    });
    expect(assignTier(a).tier).toBe("yellow");
    expect(assignTier(b).tier).toBe("yellow");
    const kept = mergeByTmdbId([a, b]).films[0]!;
    expect(assignTier(kept).tier).toBe("green");
  });

  it("Release.sources is unioned too — provenance survives on the record itself", () => {
    const kept = mergeByTmdbId([IRUMUDI_TE, IRUMUDI_TA]).films[0]!;
    expect(kept.release!.sources).toEqual(["tmdb", "wikipedia", "district", "omdb"]);
  });

  it("a field the kept row lacks is FILLED from a folded row, never overwritten", () => {
    const bare = film({
      tmdbId: 55, title: "Bare", foundIn: ["tmdb"],
      release: release({ id: "tmdb-55", title: "Bare", sources: ["tmdb"] }),
    });
    const rich = film({
      tmdbId: 55, title: "Rich", foundIn: ["district"], posterUrl: "https://img/p.jpg",
      cast: ["A", "B"], sourceUrl: "https://src", platform: "Netflix", year: 2026,
      release: release({ id: "tmdb-55", title: "Rich", sources: ["district"] }),
    });
    const kept = mergeByTmdbId([bare, rich]).films[0]!;
    expect(kept.title).toBe("Bare");                 // canonical never overwritten
    expect(kept.posterUrl).toBe("https://img/p.jpg"); // absent field filled
    expect(kept.cast).toEqual(["A", "B"]);
    expect(kept.sourceUrl).toBe("https://src");
    expect(kept.platform).toBe("Netflix");
    expect(kept.year).toBe(2026);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 4 — the variant's language becomes a PILL, not a loss", () => {
  it("Irumudi keeps its Telugu original and GAINS a Tamil dub from the folded version", () => {
    const kept = mergeByTmdbId([IRUMUDI_TE, IRUMUDI_TA]).films[0]!;
    expect(kept.release!.audioLanguages).toEqual({ original: "Telugu", dubbed: ["Tamil"] });
  });

  it("🔒 the original is NEVER also listed as a dub", () => {
    // IRUMUDI_TA carries dubbed:["Telugu"], which IS the kept row's original.
    const kept = mergeByTmdbId([IRUMUDI_TE, IRUMUDI_TA]).films[0]!;
    expect(kept.release!.audioLanguages!.dubbed).not.toContain("Telugu");
  });

  it("a same-language pair gains no pill at all", () => {
    const kept = mergeByTmdbId([MODHA_TMDB, MODHA_WIKI]).films[0]!;
    expect(kept.release!.audioLanguages).toEqual({ original: "Tamil" });
  });

  it("existing dubs survive, the merged list is sorted, and placeholders never become pills", () => {
    const a = film({
      tmdbId: 66, title: "A", language: "Hindi", foundIn: ["tmdb"],
      release: release({
        id: "tmdb-66", title: "A", sources: ["tmdb"],
        audioLanguages: { original: "Hindi", dubbed: ["Telugu"] },
      }),
    });
    const b = film({
      tmdbId: 66, title: "B", language: "Other", foundIn: ["district"],
      release: release({
        id: "tmdb-66", title: "B", sources: ["district"],
        audioLanguages: { original: "Kannada", dubbed: ["English", "Malayalam"] },
      }),
    });
    const kept = mergeByTmdbId([a, b]).films[0]!;
    // "Other" is the absence of a language and "English" is subtitle noise on an
    // Indian release — the same two rules mergeAudioLanguages already applies.
    expect(kept.release!.audioLanguages).toEqual({
      original: "Hindi",
      dubbed: ["Kannada", "Malayalam", "Telugu"],
    });
  });

  it("no audio track on the kept row ⇒ NOTHING is fabricated", () => {
    const a = film({ tmdbId: 88, title: "A", release: release({ id: "tmdb-88", title: "A", sources: ["tmdb"] }) });
    const b = film({
      tmdbId: 88, title: "B", language: "Kannada", foundIn: ["district"],
      release: release({ id: "tmdb-88", title: "B", sources: ["district"], audioLanguages: { original: "Kannada" } }),
    });
    const kept = mergeByTmdbId([a, b]).films[0]!;
    expect(kept.release!.audioLanguages).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 5 — a date disagreement is SURFACED, never swallowed", () => {
  it("a folded row's different date becomes a conflict, and the merged row goes yellow", () => {
    const a = film({
      tmdbId: 99, title: "A", foundIn: ["tmdb", "district"], date: "2026-08-21",
      release: release({ id: "tmdb-99", title: "A", sources: ["tmdb"] }),
    });
    const b = film({
      tmdbId: 99, title: "B", foundIn: ["district"], date: "2026-08-28",
      release: release({ id: "tmdb-99", title: "B", sources: ["district"] }),
    });
    const out = mergeByTmdbId([a, b]);
    const kept = out.films[0]!;
    expect(kept.conflictDetail).toContain("2026-08-21");
    expect(kept.conflictDetail).toContain("2026-08-28");
    expect(only(out.merges).dateConflict).toBeDefined();
    const t = assignTier(kept);
    expect(t.tier).toBe("yellow");
    expect(t.reasons).toContain("date-conflict");
  });

  it("agreeing dates raise no conflict", () => {
    const out = mergeByTmdbId([MODHA_TMDB, MODHA_WIKI]);
    expect(out.films[0]!.conflictDetail).toBeUndefined();
    expect(only(out.merges).dateConflict).toBeUndefined();
  });

  it("a kept row with NO date adopts a folded row's date and its provenance", () => {
    const a = film({
      tmdbId: 70, title: "A", foundIn: ["tmdb"], dateSource: "none",
      release: release({ id: "tmdb-70", title: "A", sources: ["tmdb"] }),
    });
    delete a.date;
    const b = film({
      tmdbId: 70, title: "B", foundIn: ["district"], date: "2026-08-21", dateSource: "press",
      release: release({ id: "tmdb-70", title: "B", sources: ["district"] }),
    });
    const kept = mergeByTmdbId([a, b]).films[0]!;
    expect(kept.date).toBe("2026-08-21");
    expect(kept.dateSource).toBe("press");
    expect(kept.conflictDetail).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 6 — 🔒 TMDb-LESS ROWS ARE UNTOUCHED (both directions)", () => {
  it("a manual add never merges — no tmdbId, `manual-` release id, yellow ceiling intact", () => {
    const manual = buildManualFilm(
      {
        title: "Brahmakamala", language: "Kannada", date: "2026-08-21", dateField: "theatrical",
        audioLanguages: { original: "Kannada" },
        sourceUrls: ["https://www.siasat.com/x"], evidenceBasis: "trade-press",
      },
      "theatrical",
      false
    );
    expect(manual.tmdbId).toBeUndefined();
    expect(manual.release!.id.startsWith("manual-")).toBe(true);

    const out = mergeByTmdbId([MODHA_TMDB, manual, MODHA_WIKI]);
    expect(out.films).toContain(manual);                  // same object, untouched
    expect(manual.mergedVariants).toBeUndefined();
    expect(assignTier(manual).tier).toBe("yellow");
  });

  it("TWO manual adds with the same title stay TWO rows — the title is never a merge key", () => {
    const mk = (title: string) =>
      buildManualFilm(
        {
          title, language: "Punjabi", date: "2026-08-21", dateField: "theatrical",
          audioLanguages: { original: "Punjabi" },
          sourceUrls: ["https://www.siasat.com/x"], evidenceBasis: "trade-press",
        },
        "theatrical",
        false
      );
    const out = mergeByTmdbId([mk("Judaa"), mk("Judaa")]);
    expect(out.films).toHaveLength(2);
    expect(out.merges).toHaveLength(0);
  });

  it("unverified ai-net leads (no TMDb match) stay separate rows and stay red", () => {
    const lead = (title: string): ReconciledFilm =>
      ({
        title, language: "Unknown", pillar: "theatrical", dateSource: "none",
        foundIn: ["ai-net"], status: "unverified", tier: "red",
        reasons: ["unverified — no TMDb match; title + source only"],
      }) as ReconciledFilm;
    const out = mergeByTmdbId([lead("Rangde"), lead("Rangde"), lead("Ameer Log")]);
    expect(out.films).toHaveLength(3);
    expect(out.merges).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 7 — the merge runs INSIDE reconcile, before tiering and counts", () => {
  const WIN: BucketWindow = {
    start: "2026-08-19", end: "2026-08-23", dateField: "theatrical", label: "In Theaters",
  };
  const deps: ReconcileDeps = {
    searchTitle: async () => ({ movie: [], tv: [] }),
    fetchCredits: async () => ({ leadCast: [] }),
  };

  /** The Aug-19 shape: a TMDb-net row and a district-resolved row, one id. */
  const pool: Release[] = [
    release({
      id: "tmdb-1036081", tmdbId: 1036081, title: "Khalifa Part 1", language: "Malayalam",
      releaseDate: "2026-08-20", releaseDates: { theatrical: "2026-08-20" },
      sources: ["tmdb", "omdb"], audioLanguages: { original: "Malayalam" },
    }),
    release({
      id: "tmdb-1036081", tmdbId: 1036081, title: "Khalifa", language: "Malayalam",
      releaseDate: "2026-08-20", releaseDates: { theatrical: "2026-08-20" },
      sources: ["district", "omdb"], audioLanguages: { original: "Malayalam" },
    }),
  ];

  it("two pool rows on one id reconcile to ONE film, with unioned provenance", async () => {
    const r = await reconcile({ pillar: "theatrical", tmdbPool: pool, aiFilms: [], window: WIN }, deps);
    expect(r.reconciled).toHaveLength(1);
    expect(r.reconciled[0]!.title).toBe("Khalifa Part 1");
    expect(r.reconciled[0]!.foundIn).toEqual(["tmdb", "district"]);
  });

  it("counts describe the MERGED deck — the duplicate never inflates a tier count", async () => {
    const r = await reconcile({ pillar: "theatrical", tmdbPool: pool, aiFilms: [], window: WIN }, deps);
    expect(r.counts.total).toBe(1);
    expect(r.counts.green + r.counts.yellow + r.counts.red).toBe(1);
  });

  it("🔒 the merge does NOT fire when the two pool rows carry different ids", async () => {
    const distinct: Release[] = [
      pool[0]!,
      release({ ...pool[1]!, id: "tmdb-1036082", tmdbId: 1036082 }),
    ];
    const r = await reconcile({ pillar: "theatrical", tmdbPool: distinct, aiFilms: [], window: WIN }, deps);
    expect(r.reconciled).toHaveLength(2);
  });
});
