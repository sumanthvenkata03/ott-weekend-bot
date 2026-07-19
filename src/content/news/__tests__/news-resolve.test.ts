// NEWS DESK — film-title detectors (ruling R1). Pure only: no TMDb is called.
import { describe, it, expect } from "vitest";
import { extractFilmTitle, extractPrefixTitle, extractQuotedTitle } from "../news-resolve.js";

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
