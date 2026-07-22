// NEWS DESK — film-title detectors (ruling R1). Pure only: no TMDb is called.
import { describe, it, expect } from "vitest";
import { TITLE_SIMILARITY_MIN, TMDB_YEAR_TOLERANCE, extractFilmTitle, extractPrefixTitle, extractQuotedTitle, sanityCheck, titleSimilarity } from "../news-resolve.js";

describe("extractQuotedTitle — detector (a)", () => {
  it("pulls a straight-quoted title", () => {
    expect(extractQuotedTitle("'Lenin' OTT release: when and where to watch")).toBe("Lenin");
  });

  it("pulls a curly-quoted title", () => {
    expect(extractQuotedTitle("‘Chinna Chinna Aasai’ OTT release date out")).toBe("Chinna Chinna Aasai");
  });

  it("pulls a double-quoted title", () => {
    expect(extractQuotedTitle('"Balan The Boy" heads to ZEE5')).toBe("Balan The Boy");
  });

  it("returns null when nothing is quoted", () => {
    expect(extractQuotedTitle("Raayan wins Best Tamil Film at the National Awards")).toBeNull();
  });
});

describe("extractPrefixTitle — detector (b)", () => {
  it("takes the span before a colon", () => {
    expect(extractPrefixTitle("Maa Inti Bangaaram: Box Office Collections")).toBe("Maa Inti Bangaaram");
  });

  it("takes the span before an announcement verb", () => {
    expect(extractPrefixTitle("Balan The Boy Locks Pan-Indian OTT Release Date")).toBe("Balan The Boy");
    expect(extractPrefixTitle("Nani's The Paradise Sets Landmark Theatrical Deal")).toBe("Nani's The Paradise");
  });

  it("refuses a wire-service prefix that is not a title", () => {
    expect(extractPrefixTitle("Report: something happened today")).toBeNull();
    expect(extractPrefixTitle("Exclusive: a thing occurred")).toBeNull();
  });

  it("refuses a sentence-length span", () => {
    expect(
      extractPrefixTitle("A very long headline about many different things indeed happening: today")
    ).toBeNull();
  });
});

describe("extractFilmTitle — detector precedence", () => {
  it("prefers the QUOTED title over the colon prefix", () => {
    const got = extractFilmTitle("'Lenin' OTT release: when and where to watch");
    expect(got).toEqual({ title: "Lenin", confidence: "quoted" });
  });

  it("falls back to prefix when nothing is quoted", () => {
    const got = extractFilmTitle("Balan The Boy Locks Pan-Indian OTT Release Date");
    expect(got?.confidence).toBe("prefix");
  });

  it("returns null on an event headline with no film in front", () => {
    // The NFA case — winner-film extraction is explicitly out of v1 scope.
    expect(extractFilmTitle("72nd National Awards: Complete list of winners is here")).not.toBeNull();
    expect(extractFilmTitle("Awards season continues across the industry")).toBeNull();
  });
});

// ── RESOLVER V2 — the sanity gate ──────────────────────────────────────────

describe("titleSimilarity", () => {
  it("is 1 for the same title", () => {
    expect(titleSimilarity("Article 370", "Article 370")).toBe(1);
  });

  it("ignores articles and punctuation", () => {
    expect(titleSimilarity("The Paradise", "Paradise")).toBe(1);
    expect(titleSimilarity("35 – Chinna Katha Kaadu", "35 Chinna Katha Kaadu")).toBe(1);
  });

  it("is 0 for unrelated titles", () => {
    expect(titleSimilarity("G.D.N", "Hulk and the Agents of S.M.A.S.H.")).toBeLessThan(0.6);
  });
});

describe("sanityCheck — the Hulk class", () => {
  it("REJECTS the G.D.N → Hulk match that shipped a wrong poster", () => {
    const v = sanityCheck("G.D.N", { title: "Hulk and the Agents of S.M.A.S.H.", year: 2013 }, 2026);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("REJECTED low-sim");
    expect(v.reason).toContain("Hulk and the Agents");
  });

  it("ACCEPTS a genuine match in the window", () => {
    const v = sanityCheck("Article 370", { title: "Article 370", year: 2024 }, 2026);
    expect(v.ok).toBe(true);
    expect(v.similarity).toBe(1);
  });

  it("REJECTS a same-title film far outside the year window (the 2019 Blast trap)", () => {
    const v = sanityCheck("Blast", { title: "Blast", year: 2019 }, 2026);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("REJECTED year");
  });

  it("a JUDGED match overrides the year gate — we already hold that identity", () => {
    const v = sanityCheck("Blast", { title: "Blast", year: 2019 }, 2026, true);
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("+judged");
  });

  it("accepts a hit with no year rather than guessing", () => {
    expect(sanityCheck("Kattalan", { title: "Kattalan" }, 2026).ok).toBe(true);
  });

  it("the threshold is the documented constant", () => {
    expect(TITLE_SIMILARITY_MIN).toBe(0.6);
    expect(TMDB_YEAR_TOLERANCE).toBe(3);
  });
});
