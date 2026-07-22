// THE COMPLETENESS CONTRACT — every card slot proven present BEFORE render.
//
// The five founding fixtures are the real films from Issue 026 (2026-07-22),
// reconstructed from that run's persisted manifest and the cached TMDb records.
// Pure: no network, no clock, no filesystem.
import { describe, it, expect } from "vitest";
import {
  buildManifest,
  MIN_SYNOPSIS_CHARS,
  type BucketWindow,
  type ContractOptions,
  type FilmInBucket,
} from "../post-validator.js";
import type { Release } from "../types.js";

const WIN: BucketWindow = {
  start: "2026-07-22", end: "2026-07-26", dateField: "theatrical", label: "In Theaters",
};
const WINDOWS = { theatrical: WIN };
const EDITION_DATE = "2026-07-22";
const CONTRACT = { cardType: "wed-drop" as const, editionDate: EDITION_DATE };

/**
 * A COMPLETE Wed Drop film — every contract check passes.
 *
 * Overrides set to `undefined` mean "this field is ABSENT", which is what the
 * fixtures are actually modelling. The repo runs exactOptionalPropertyTypes, so
 * an explicit `undefined` is NOT the same as an omitted key — the undefined
 * entries are deleted here so the fixture is genuinely field-less.
 */
function completeFilm(p: Record<string, unknown> = {}): Release {
  const base: Release = {
    id: "tmdb-1", tmdbId: 1, title: "Complete Film", language: "Tamil", isSeries: false,
    platform: [], releaseDate: "2026-07-24",
    releaseDates: { theatrical: "2026-07-24" },
    genre: ["Drama"], cast: ["A Actor"], leadCast: ["A Actor", "B Actor"],
    synopsis: "A long-enough synopsis that genuinely describes the film's premise in " +
      "sufficient detail to ground an editorial why-line without inventing anything.",
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
    audioLanguages: { original: "Tamil" },
    subtitleLanguages: [], sources: ["tmdb"], fetchedAt: "2026-07-22T00:00:00.000Z",
  };
  const out: Record<string, unknown> = { ...base, ...p };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as Release;
}
const row = (films: FilmInBucket[], contract: ContractOptions = CONTRACT) =>
  buildManifest("Wed Drop · Theatrical", "026", films, WINDOWS, {}, contract).rows[0]!;
const one = (film: Release, whyLine?: string) =>
  row([{ film, bucket: "theatrical", ...(whyLine !== undefined ? { whyLine } : {}) }]);

describe("contract — a complete film passes clean", () => {
  it("every check green ⇒ pass with no reason", () => {
    const r = one(completeFilm(), "A rain-soaked thriller that earns its final ten minutes.");
    expect(r.status).toBe("pass");
    expect(r.reason).toBe("");
  });
});

describe("contract — OPT-IN: other pillars are untouched", () => {
  it("no cardType ⇒ none of the card checks run", () => {
    // Sat Verdict / Mon Movement / Sun Spotlight pass no contract and must be
    // byte-for-byte unaffected by this whole feature.
    const bare = completeFilm({ posterUrl: undefined, audioLanguages: undefined, cast: [], leadCast: undefined });
    const r = row([{ film: bare, bucket: "theatrical" }], {});
    expect(r.status).toBe("pass");
    expect(r.reason).toBe("");
  });

  it("the SAME film fails once the wed-drop contract is applied", () => {
    const bare = completeFilm({ posterUrl: undefined, audioLanguages: undefined, cast: [], leadCast: undefined });
    expect(one(bare).status).toBe("fail");
  });
});

describe("FOUNDING FIXTURE — Chennai Love Story (card 11): the missing ★ RELEASED band", () => {
  // Issue 026 manifest row 11: status "fail", qualifyingDate null. Cached TMDb
  // /movie/1443136/release_dates carried AU, GB, IE, NZ, US — and no IN row.
  const chennai = completeFilm({
    id: "tmdb-1443136", tmdbId: 1443136, title: "Chennai Love Story", language: "Telugu",
    releaseDate: "2026-07-24", releaseDates: undefined,
  });

  it("names contract:band-released — the band that would not have rendered", () => {
    const r = one(chennai, "A romance with more on its mind than it lets on.");
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("contract:band-released");
    expect(r.reason).toContain("★ RELEASED");
  });

  it("R2 — with the discover fallback applied it passes, flagged as weaker provenance", () => {
    const rescued = completeFilm({
      ...chennai, releaseDates: { theatrical: "2026-07-24" }, releaseDatesFallback: "discover",
    });
    const r = one(rescued, "A romance with more on its mind than it lets on.");
    expect(r.status).toBe("warn");
    expect(r.reason).toContain("date: discover-fallback");
    expect(r.reason).not.toContain("contract:band-released");
  });
});

describe("FOUNDING FIXTURE — Ottam Thullal (card 12): the missing ★ AVAILABLE IN band", () => {
  // Manifest row 12 PASSED the old landing check (it had a date), so nothing
  // objected — while the card shipped with no language band at all. Cached
  // /movie/1070172 has spoken_languages ["ml"]: the data existed and was never
  // attached, because buildFromNewAi never sets audioLanguages.
  const ottam = completeFilm({
    id: "tmdb-1070172", tmdbId: 1070172, title: "Ottam Thullal", language: "Malayalam",
    releaseDates: { theatrical: "2026-07-24" }, audioLanguages: undefined,
  });

  it("names contract:band-available-in", () => {
    const r = one(ottam, "A wry Malayalam comedy that sneaks up on you.");
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("contract:band-available-in");
    expect(r.reason).toContain("★ AVAILABLE IN");
  });

  it("REGRESSION — the OLD landing check alone called this film clean", () => {
    // Proof the contract is load-bearing: without a cardType this exact film is
    // a "pass", which is precisely how it reached a published card.
    expect(row([{ film: ottam, bucket: "theatrical" }], {}).status).toBe("pass");
  });

  it("an Ottam-shaped film WITH audioLanguages renders the band and passes", () => {
    const fixed = completeFilm({ ...ottam, audioLanguages: { original: "Malayalam" } });
    expect(one(fixed, "A wry Malayalam comedy that sneaks up on you.").status).toBe("pass");
  });
});

describe("FOUNDING FIXTURE — The India Story: poster_path null (R5)", () => {
  // Cached /movie/1682974 has poster_path: null. It carded on the typographic
  // fallback and the old manifest said "pass" with no mention of it.
  const india = completeFilm({
    id: "tmdb-1682974", tmdbId: 1682974, title: "The India Story", language: "Hindi",
    posterUrl: undefined,
  });

  it("WARNS, never fails — a TMDb art gap must not eat a real film", () => {
    const r = one(india, "A documentary that finally lets its subjects speak.");
    expect(r.status).toBe("warn");
    expect(r.reason).toContain("contract:poster");
    expect(r.reason).toContain("typographic fallback");
  });

  it("a warn never makes the manifest un-ok, so it can never block auto", () => {
    const m = buildManifest("Wed Drop · Theatrical", "026",
      [{ film: india, bucket: "theatrical", whyLine: "A documentary that lets its subjects speak." }],
      WINDOWS, {}, CONTRACT);
    expect(m.ok).toBe(true);
    expect(m.failCount).toBe(0);
    expect(m.warnCount).toBe(1);
  });
});

describe("FOUNDING FIXTURE — Jana Nayagan: the pre-release seal (R7)", () => {
  // Manifest row 1 of Issue 026 — and the source of that edition's "warn 1".
  // A Jul 23 film showing a 7.1 on Jul 22: nobody had seen it yet.
  const jana = completeFilm({
    id: "tmdb-1235877", tmdbId: 1235877, title: "Jana Nayagan", language: "Tamil",
    releaseDate: "2026-07-23", releaseDates: { theatrical: "2026-07-23" },
    imdbRating: 7.1, imdbVotes: 0,
  });

  it("a numeric score on a film that has not released yet FAILS the contract", () => {
    const r = one(jana, "The year's biggest Tamil opening, finally here.");
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("contract:pre-release-seal");
    expect(r.reason).toContain("2026-07-23");
  });

  it("the same film with NO score passes — the seal, not the film, is the problem", () => {
    const noScore = completeFilm({ ...jana, imdbRating: undefined, tbsiScore: undefined });
    expect(one(noScore, "The year's biggest Tamil opening, finally here.").status).toBe("pass");
  });

  it("a film released ON the edition date is not pre-release", () => {
    const today = completeFilm({ ...jana, releaseDates: { theatrical: EDITION_DATE } });
    expect(one(today, "Out today.").reason).not.toContain("pre-release-seal");
  });

  it("suppression is independent of vote base — a well-voted pre-release still fails", () => {
    const voted = completeFilm({ ...jana, imdbVotes: 5000, tmdbVoteCount: 900 });
    expect(one(voted, "The year's biggest Tamil opening.").reason).toContain("contract:pre-release-seal");
  });
});

describe("FOUNDING FIXTURE — Pallichattambi: why-line grounding (R4)", () => {
  // "master plans backfire" came from a synopsis too thin to ground any claim.
  const palli = completeFilm({
    id: "tmdb-959894", tmdbId: 959894, title: "Pallichattambi", language: "Malayalam",
    synopsis: "A village tale.",
  });

  it("a thin synopsis warns that the why-line must be deterministic", () => {
    const r = one(palli, "A comedy where the master plans backfire.");
    expect(r.status).toBe("warn");
    expect(r.reason).toContain("contract:why-line-grounding");
    expect(r.reason).toContain("deterministic fallback");
  });

  it("names the measured length against the floor, so the call is auditable", () => {
    const r = one(palli, "A comedy where the master plans backfire.");
    expect(r.reason).toContain(`${"A village tale.".length}c`);
    expect(r.reason).toContain(`${MIN_SYNOPSIS_CHARS}c`);
  });

  it("an absent synopsis is treated as ungrounded too", () => {
    expect(one(completeFilm({ synopsis: "" }), "A claim.").reason).toContain("why-line-grounding");
  });

  it("a full synopsis grounds the line and does not warn", () => {
    expect(one(completeFilm(), "A claim about the premise.").reason).not.toContain("why-line-grounding");
  });

  it("an EMPTY why-line is a fail, not a warn — the card would have no copy", () => {
    const r = one(completeFilm(), "   ");
    expect(r.status).toBe("fail");
    expect(r.reason).toContain("contract:why-line");
  });
});

describe("contract — cast is a warn, matching the template's optional Line 2", () => {
  it("no cast ⇒ warn", () => {
    const r = one(completeFilm({ cast: [], leadCast: undefined }), "A line.");
    expect(r.status).toBe("warn");
    expect(r.reason).toContain("contract:cast");
  });

  it("leadCast alone satisfies it", () => {
    expect(one(completeFilm({ cast: [], leadCast: ["X"] }), "A line.").reason).not.toContain("contract:cast");
  });
});

describe("contract — every failing check NAMES itself", () => {
  it("a film failing several checks lists each by name", () => {
    const broken = completeFilm({
      releaseDates: undefined, audioLanguages: undefined, posterUrl: undefined,
      cast: [], leadCast: undefined,
    });
    const r = one(broken, "A line.");
    expect(r.status).toBe("fail");
    for (const name of ["contract:band-released", "contract:band-available-in", "contract:poster", "contract:cast"]) {
      expect(r.reason).toContain(name);
    }
  });
});
