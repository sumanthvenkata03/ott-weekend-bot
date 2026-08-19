// WD-046-SEAL / WD-046-SEAL-B — OTT ARRIVALS WEAR THE RATINGS SEAL.
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// Every Wed Drop card printed the NEW ("just dropped, no verdict yet") stamp,
// including OTT arrivals of films that had finished theatrical runs weeks
// earlier: Welcome to the Jungle (theatrical Jun 26, 20,824 IMDb votes),
// Jana Nayagan (Jul 23, 5,158), Chennai Love Story (Jul 24, 2,411), The Great
// Grand Superhero (May 29, 2,689).
//
// TWO separate faults, and the diagnosis order matters:
//   1. NOT the template, and NOT pillar-hardcoding. buildStampContext is fully
//      data-driven and Wed Drop was already wired to it. The vote base simply
//      never arrived: OMDb answers imdbVotes "N/A" for new Indian titles, and
//      the MDBList client's zod schema STRIPPED the `votes` field it mirrors
//      from IMDb. hasRealVoteBase could then only pass on TMDb's own count,
//      which sits at 0-25 against a floor of 50. Fixed in the client.
//   2. Entitlement was never expressed. Once votes flow, a score alone would
//      also seal a THEATRICAL premiere — a film with no prior run, whose only
//      possible score belongs to some other release. wearsArrivalSeal is that
//      missing rule.
//
// ── THE FLOOR IS NOT TOUCHED ───────────────────────────────────────────────
// hasRealVoteBase is unchanged, and wearsArrivalSeal CALLS it rather than
// restating it. Nothing here fabricates a score: a film that fails either half
// falls back to the honest NEW stamp, which is a seal in its own right.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOttArrival,
  wearsArrivalSeal,
  hasRealVoteBase,
  awardsNumericSeal,
  type SealInput,
} from "../seal-decision.js";
import { buildStampContext } from "../../rendering/_shared.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** A deck row as both predicates see it: the seal fields plus the two dates. */
type Row = SealInput & {
  releaseDates?: { theatrical?: string; ott?: string };
  releaseDate?: string;
  imdbRating?: number;
  rottenTomatoes?: number;
  letterboxd?: number;
};

/** The four real Aug-19 arrivals, with the vote counts MDBList actually returns. */
const WELCOME: Row = {
  releaseDates: { theatrical: "2026-06-26", ott: "2026-08-21" },
  releaseDate: "2026-08-21",
  tbsiScore: 4.9, imdbRating: 4.6, rottenTomatoes: 43, letterboxd: 2.6,
  imdbVotes: 20824, tmdbVoteAverage: 5.1, tmdbVoteCount: 25,
};
const JANA: Row = {
  releaseDates: { theatrical: "2026-07-23", ott: "2026-08-21" },
  releaseDate: "2026-08-21",
  tbsiScore: 4.9, imdbRating: 5.5, imdbVotes: 5158, tmdbVoteAverage: 5.5, tmdbVoteCount: 14,
};
/** Direct-to-OTT premiere — no theatrical date at all. */
const PPK: Row = {
  releaseDates: { ott: "2026-08-21" },
  releaseDate: "2026-08-21",
  tmdbVoteAverage: 0, tmdbVoteCount: 0,
};
/** Manual add: no TMDb/IMDb linkage, so no rating record of any kind. */
const SRINIVASA: Row = { releaseDates: { ott: "2026-08-20" }, releaseDate: "2026-08-20" };
/** Streams BEFORE it opens in cinemas — theatrical is AFTER the OTT date. */
const IM_GAME: Row = {
  releaseDates: { theatrical: "2026-09-03", ott: "2026-08-20" },
  releaseDate: "2026-08-20",
};

// ════════════════════════════════════════════════════════════════════════════
describe("PART A — isOttArrival: a prior theatrical run, and nothing else", () => {
  it("a real arrival — theatrical strictly before the OTT date", () => {
    expect(isOttArrival(WELCOME)).toBe(true);
    expect(isOttArrival(JANA)).toBe(true);
  });

  it("🔒 a direct-to-OTT PREMIERE is not an arrival (no theatrical date)", () => {
    expect(isOttArrival(PPK)).toBe(false);
  });

  it("🔒 a rating-less MANUAL ADD is not an arrival", () => {
    expect(isOttArrival(SRINIVASA)).toBe(false);
  });

  it("🔒 streaming BEFORE the cinema run is not an arrival — nothing has had a run yet", () => {
    expect(isOttArrival(IM_GAME)).toBe(false);
  });

  it("🔒 same-day theatrical+OTT is not an arrival — STRICTLY before is required", () => {
    expect(isOttArrival({ releaseDates: { theatrical: "2026-08-21", ott: "2026-08-21" } })).toBe(false);
  });

  it("a decade-old theatrical run still counts as an arrival (Dial 1975)", () => {
    expect(isOttArrival({ releaseDates: { theatrical: "2016-07-01", ott: "2026-08-21" } })).toBe(true);
  });

  it("🔒 malformed dates are REJECTED, never string-compared as garbage", () => {
    expect(isOttArrival({ releaseDates: { theatrical: "26 June 2026", ott: "2026-08-21" } })).toBe(false);
    expect(isOttArrival({ releaseDates: { theatrical: "2026-06-26", ott: "soon" } })).toBe(false);
    expect(isOttArrival(undefined)).toBe(false);
    expect(isOttArrival({})).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART B — wearsArrivalSeal: BOTH halves required", () => {
  it("arrival + vote base => seal", () => {
    expect(wearsArrivalSeal("ott", WELCOME)).toBe(true);
    expect(wearsArrivalSeal("ott", JANA)).toBe(true);
  });

  it("🔒 an arrival with NO vote base => NEW (the pre-SEAL-B state of every row)", () => {
    const { imdbVotes: _drop, ...noVotes } = WELCOME;
    expect(hasRealVoteBase(noVotes)).toBe(false);
    expect(wearsArrivalSeal("ott", noVotes)).toBe(false);
  });

  it("🔒 a premiere WITH a big vote base still => NEW — entitlement, not just data", () => {
    const premiereWithVotes: Row = { ...PPK, tbsiScore: 8.4, imdbRating: 8.4, imdbVotes: 99999 };
    expect(hasRealVoteBase(premiereWithVotes)).toBe(true);          // the data would allow it…
    expect(wearsArrivalSeal("ott", premiereWithVotes)).toBe(false); // …the rule does not
  });

  it("🔒 THE THEATRICAL EDITION IS ALWAYS NEW, even with an arrival-shaped record", () => {
    expect(wearsArrivalSeal("theatrical", WELCOME)).toBe(false);
    expect(wearsArrivalSeal("theatrical", JANA)).toBe(false);
  });

  it("🔒 the manual add and the premiere are NEW on every edition", () => {
    for (const edition of ["ott", "theatrical"]) {
      expect(wearsArrivalSeal(edition, SRINIVASA)).toBe(false);
      expect(wearsArrivalSeal(edition, PPK)).toBe(false);
      expect(wearsArrivalSeal(edition, IM_GAME)).toBe(false);
    }
  });

  it("undefined release => false, never a throw", () => {
    expect(wearsArrivalSeal("ott", undefined)).toBe(false);
  });

  it("🔒 the ENG-10 FLOOR IS CALLED, NOT RESTATED — one definition only", () => {
    // wearsArrivalSeal must delegate. If the floor moves, this moves with it.
    const src = read("src/shared/seal-decision.ts");
    expect(src).toMatch(/isOttArrival\(rel\) && hasRealVoteBase\(rel\)/);
    // And the floor itself is untouched by this packet.
    expect(hasRealVoteBase({ imdbVotes: 1 })).toBe(true);
    expect(hasRealVoteBase({ imdbVotes: 0 })).toBe(false);
    expect(hasRealVoteBase({ tmdbVoteCount: 50 })).toBe(true);
    expect(hasRealVoteBase({ tmdbVoteCount: 49 })).toBe(false);
    expect(hasRealVoteBase({})).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART C — the seal a qualifying card actually prints", () => {
  it("Welcome to the Jungle prints its TBSI blend with the real receipts", () => {
    const stamp = buildStampContext(WELCOME);
    expect(stamp.stampKind).toBe("tbsi");
    expect(stamp.stampLabel).toBe("TBSI");
    expect(stamp.stampScore).toBe("4.9");
    expect(stamp.stampRingText).toBe("IMDb 4.6 · RT 43% · LB 2.6");
  });

  it("a non-qualifying card is shown the DATE ONLY, so NEW keeps its wording", () => {
    // The score fields are WITHHELD rather than the seal blanked — this is what
    // keeps "NEW" from degrading into "UNRATED" on a just-released film.
    const stamp = buildStampContext({ releaseDate: "2026-08-21" });
    expect(stamp.stampKind).toBe("new");
    expect(stamp.stampLabel).toBe("NEW");
    expect(stamp.stampRingText).toBe("JUST DROPPED · NO VERDICT YET");
    expect(stamp.stampScore).toBeUndefined();
  });

  it("🔒 withholding is not the same as blanking — an EMPTY input reads UNRATED", () => {
    // Passing `undefined` would lose the recency wording. Pinned so the caller
    // cannot be "simplified" into dropping releaseDate.
    expect(buildStampContext(undefined).stampLabel).toBe("UNRATED");
  });

  it("awardsNumericSeal still describes the DATA, independent of entitlement", () => {
    // The verifier's question ("does the record justify a number?") and the
    // card's question ("is this film entitled to one?") stay separate.
    expect(awardsNumericSeal(WELCOME)).toBe(true);
    expect(awardsNumericSeal(SRINIVASA)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART D — 🔒 FRIDAY ARCHIVES IS UNTOUCHED", () => {
  it("Archives still draws its OWN seal, not the shared stamp component", () => {
    const card = read("src/rendering/templates/archives-card.html");
    expect(card).toMatch(/class="seal-score"/);
    expect(card).not.toContain('include "_tbsi-stamp.html"');
  });

  it("the Archives renderer never consults the arrival rule", () => {
    const src = read("src/rendering/render-archives.ts");
    expect(src).not.toContain("wearsArrivalSeal");
    expect(src).not.toContain("isOttArrival");
  });

  it("its own vote gate is still the selector's, at 2000", () => {
    const sel = read("src/content/archives/archives-select.ts");
    expect(sel).toMatch(/imdbVotes\s*≥\s*2000/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART E — 🔒 THE WIRING, at the one call site", () => {
  const src = read("src/rendering/render-wed-drop.ts");

  it("the stamp input is gated by wearsArrivalSeal", () => {
    expect(src).toContain("wearsArrivalSeal(edition, release)");
  });

  it("the non-qualifying branch passes the DATE, never the scored release", () => {
    expect(src).toMatch(/release\.releaseDate \? \{ releaseDate: release\.releaseDate \} : undefined/);
  });

  it("🔒 the seal RESERVE still keys off stampKind, not off a score", () => {
    // Issue 032: a score-based gate left every NEW-seal card unreserved and
    // shipped 31 issues of blurb/seal overlap. Unchanged by this packet.
    expect(src).toMatch(/stamp\.stampKind === "tbsi" \|\| stamp\.stampKind === "tmdb" \|\| stamp\.stampKind === "new"/);
  });
});
