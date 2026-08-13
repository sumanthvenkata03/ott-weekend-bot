// SEAL VOTE-BASE GUARD — a TBSI seal requires a real audience, not just a number.
//
// Issue 041 (Wed Drop, 12 Aug 2026) shipped three OTT cards printing confident
// TBSI medallions on films nobody had voted on: Cocktail 2 at 6.3 (20 TMDb
// votes, no IMDb votes), Bharat Bhhagya Viddhaata at 7.0 (zero votes, one
// source), Heartin at 7.5 (two votes, one source). The landing verifier warned
// "score shown with no real vote base" on all three; the renderer printed them
// anyway, because buildStampContext's tbsi branch only checked that tbsiScore
// existed. The fixtures below are those exact films.
//
// isRecentRelease() reads the wall clock, so the system time is pinned to the
// edition date — otherwise these assertions would silently flip NEW → UNRATED
// ten days after they were written.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildStampContext, TMDB_FALLBACK_MIN_VOTES } from "../_shared.js";
import { hasRealVoteBase } from "../../shared/post-validator.js";

/** The Issue 041 edition date. */
const EDITION_NOW = new Date("2026-08-12T12:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EDITION_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

// ── Regression fixtures: verbatim from output/runs/wed-drop-ott-2026-08-12-draft.json ──
const COCKTAIL_2 = {
  tbsiScore: 6.3,
  imdbRating: 7.6,
  rottenTomatoes: 23,
  letterboxd: 2.5,
  tmdbVoteAverage: 5.75,
  tmdbVoteCount: 20,
  releaseDate: "2026-08-14",
}; // imdbVotes: absent in the source data

const BHARAT_BHHAGYA_VIDDHAATA = {
  tbsiScore: 7,
  imdbRating: 7,
  tmdbVoteAverage: 0,
  tmdbVoteCount: 0,
  releaseDate: "2026-08-14",
};

const HEARTIN = {
  tbsiScore: 7.5,
  imdbRating: 7.5,
  tmdbVoteAverage: 6,
  tmdbVoteCount: 2,
  releaseDate: "2026-08-14",
};

const SARVAGUNN_SAMPANN = {
  tmdbVoteAverage: 0,
  tmdbVoteCount: 0,
  releaseDate: "2026-08-14",
}; // no tbsiScore — was already NEW before this change

const AROOPI = {
  tmdbVoteAverage: 0,
  tmdbVoteCount: 0,
  releaseDate: "2026-08-14",
};

/** Issue 036's Uyir — a scored film that DOES carry a real vote base. */
const UYIR = {
  tbsiScore: 8.1,
  imdbRating: 8.1,
  imdbVotes: 514,
  releaseDate: "2026-08-04",
};

describe("the three Issue 041 regressions now fall through to NEW", () => {
  it.each([
    ["Cocktail 2", COCKTAIL_2, 6.3, "20 TMDb votes, no IMDb votes"],
    ["Bharat Bhhagya Viddhaata", BHARAT_BHHAGYA_VIDDHAATA, 7, "zero votes, one source"],
    ["Heartin", HEARTIN, 7.5, "two TMDb votes, one source"],
  ])("%s (tbsi %s — %s) gets no seal score", (_name, film, score, _why) => {
    const stamp = buildStampContext(film);
    expect(stamp.stampKind).toBe("new");
    expect(stamp.stampLabel).toBe("NEW");
    expect(stamp.stampRingText).toBe("JUST DROPPED · NO VERDICT YET");
    // The number must not reach the card in ANY field.
    expect(stamp.stampScore).toBeUndefined();
    expect(JSON.stringify(stamp)).not.toContain(String(score));
  });

  it("all three fail the shared predicate — the seal and the verifier now agree", () => {
    for (const film of [COCKTAIL_2, BHARAT_BHHAGYA_VIDDHAATA, HEARTIN]) {
      expect(hasRealVoteBase(film)).toBe(false);
    }
  });
});

describe("control — a real vote base still earns the TBSI seal", () => {
  it("Uyir (imdbVotes 514) keeps its 8.1 seal", () => {
    const stamp = buildStampContext(UYIR);
    expect(stamp.stampKind).toBe("tbsi");
    expect(stamp.stampLabel).toBe("TBSI");
    expect(stamp.stampScore).toBe("8.1");
    expect(hasRealVoteBase(UYIR)).toBe(true);
  });

  it("a single IMDb vote is enough — the predicate is > 0, not a quorum", () => {
    const stamp = buildStampContext({ tbsiScore: 6.3, imdbRating: 7.6, imdbVotes: 1, releaseDate: "2026-08-14" });
    expect(stamp.stampKind).toBe("tbsi");
    expect(stamp.stampScore).toBe("6.3");
  });

  it("TMDb votes alone qualify at the threshold, not one below it", () => {
    const at = buildStampContext({ tbsiScore: 6.3, tmdbVoteCount: 50, tmdbVoteAverage: 5.75, releaseDate: "2026-08-14" });
    const below = buildStampContext({ tbsiScore: 6.3, tmdbVoteCount: 49, tmdbVoteAverage: 5.75, releaseDate: "2026-08-14" });
    expect(at.stampKind).toBe("tbsi");
    expect(at.stampScore).toBe("6.3");
    expect(below.stampKind).toBe("new");
  });

  it("the guard adds a condition and removes none — no tbsiScore is still no seal", () => {
    expect(buildStampContext({ imdbVotes: 9999, releaseDate: "2026-08-14" }).stampKind).toBe("new");
  });
});

describe("films that were already NEW are untouched", () => {
  it.each([
    ["Sarvagunn Sampann", SARVAGUNN_SAMPANN],
    ["Aroopi", AROOPI],
  ])("%s still reads NEW / JUST DROPPED", (_name, film) => {
    const stamp = buildStampContext(film);
    expect(stamp.stampKind).toBe("new");
    expect(stamp.stampLabel).toBe("NEW");
    expect(stamp.stampRingText).toBe("JUST DROPPED · NO VERDICT YET");
  });

  it("an OLD unrated film still reads UNRATED, not NEW", () => {
    const stamp = buildStampContext({ releaseDate: "2020-01-01" });
    expect(stamp.stampKind).toBe("new");
    expect(stamp.stampLabel).toBe("UNRATED");
    expect(stamp.stampRingText).toBe("NO VERDICT YET");
  });

  it("scoreAbsenceLabel still overrides the arc text on the fall-through path", () => {
    const stamp = buildStampContext(HEARTIN, { scoreAbsenceLabel: "NO SCORE YET" });
    expect(stamp.stampRingText).toBe("JUST DROPPED · NO SCORE YET");
  });

  it("undefined release is unchanged", () => {
    expect(buildStampContext(undefined).stampKind).toBe("new");
  });
});

describe("fall-through lands on 'new', never on the muted 'tmdb' seal", () => {
  // The two branches are mutually exclusive by arithmetic: failing the vote-base
  // predicate forces tmdbVoteCount < 50, while the tmdb branch demands >= 50. If
  // anyone ever lowers TMDB_FALLBACK_MIN_VOTES below the predicate's threshold, a
  // vote-base-failing film would start printing a tmdb score and this fails.
  it("the tmdb fallback threshold is not looser than the vote-base standard", () => {
    expect(TMDB_FALLBACK_MIN_VOTES).toBeGreaterThanOrEqual(50);
  });

  it("no vote count exists that both fails the predicate and passes the tmdb branch", () => {
    for (let votes = 0; votes <= 120; votes++) {
      const film = { tbsiScore: 6.3, tmdbVoteAverage: 5.75, tmdbVoteCount: votes, releaseDate: "2026-08-14" };
      const stamp = buildStampContext(film);
      if (!hasRealVoteBase(film)) {
        expect(stamp.stampKind, `votes=${votes}`).toBe("new");
      } else {
        expect(stamp.stampKind, `votes=${votes}`).toBe("tbsi");
      }
    }
  });

  it("a film with NO tbsiScore but heavy TMDb votes still gets the muted tmdb seal", () => {
    // The tmdb branch itself must remain reachable — the guard is scoped to tbsi.
    const stamp = buildStampContext({ tmdbVoteAverage: 7.2, tmdbVoteCount: 800, releaseDate: "2026-08-14" });
    expect(stamp.stampKind).toBe("tmdb");
    expect(stamp.stampScore).toBe("7.2");
    expect(stamp.stampRingText).toBe("800 VOTES");
  });
});

describe("the Sat Verdict grounded-research path is unaffected", () => {
  // That branch returns before the tbsi branch and is driven by critic research,
  // not aggregator votes — a vote-base guard must not reach it.
  it("a grounded research seal prints with zero aggregator votes", () => {
    const stamp = buildStampContext(
      { tmdbVoteCount: 0, releaseDate: "2026-08-14" },
      { research: { tbsiScore: 8.0, star: 4.0, confidence: "high", audienceImdb: 7.9, criticCount: 4 } }
    );
    expect(stamp.stampKind).toBe("tbsi");
    expect(stamp.stampScore).toBe("8.0");
    expect(stamp.stampStar).toBe("4.0");
    expect(stamp.stampRingText).toBe("IMDb 7.9 · 4 CRITICS");
  });

  it("research with confidence 'none' still routes to the absence state", () => {
    const stamp = buildStampContext(
      { tbsiScore: 7.5, tmdbVoteCount: 2, releaseDate: "2026-08-14" },
      { research: { tbsiScore: null, star: null, confidence: "none" } }
    );
    expect(stamp.stampKind).toBe("new");
    expect(stamp.stampLabel).toBe("NEW");
  });
});
