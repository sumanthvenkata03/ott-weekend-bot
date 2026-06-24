// normalize.test.ts — pins normalizeTitle, the dedupe-key normalizer. Pure
// function, zero imports beyond the module under test, so no mocks are needed.
//
// The cardinal rule it protects: a WRONG merge (two distinct films onto one
// key) is worse than a MISSED merge. Several cases below lock the guards that
// keep wrong merges from creeping back in.
import { describe, it, expect } from "vitest";
import { normalizeTitle } from "../normalize.js";

describe("normalizeTitle — positive transforms", () => {
  it("lowercases", () => {
    expect(normalizeTitle("PUSHPA")).toBe("pushpa");
  });

  it("strips diacritics (NFKD + combining-mark removal)", () => {
    expect(normalizeTitle("Café")).toBe("cafe");
    expect(normalizeTitle("Pushpā")).toBe("pushpa");
  });

  it("turns punctuation into spaces and collapses runs", () => {
    expect(normalizeTitle("Spider-Man")).toBe("spider man");
    expect(normalizeTitle("K.G.F: Chapter 1")).toBe("k g f chapter 1");
    expect(normalizeTitle("  double   spaced  ")).toBe("double spaced");
  });

  it("canonicalizes a standalone & to the word 'and'", () => {
    expect(normalizeTitle("Tom & Jerry")).toBe("tom and jerry");
    // & and the spelled-out word converge -> a cross-net match.
    expect(normalizeTitle("Tom & Jerry")).toBe(normalizeTitle("Tom and Jerry"));
  });
});

describe("normalizeTitle — wrong-merge guards (🔒 regression)", () => {
  it("🔒 & expands to a STANDALONE token, never glued mid-word", () => {
    // "&" -> " and " (surrounded by spaces) so it can only ever match the
    // standalone word "and" — it must NOT fuse into an adjacent word.
    expect(normalizeTitle("M&M")).toBe("m and m");
    expect(normalizeTitle("MandM")).toBe("mandm");
    expect(normalizeTitle("M&M")).not.toBe(normalizeTitle("MandM"));
    // And there is no reverse (word "and" -> "&") transform: letters "and"
    // living inside a larger word are left untouched.
    expect(normalizeTitle("Anand")).toBe("anand");
  });

  it("🔒 trailing-paren strip is whitelist-only — non-whitelisted parentheticals survive", () => {
    // Whitelisted disambiguators ARE stripped (so they match TMDb's bare title)…
    expect(normalizeTitle("Identity (2025 film)")).toBe("identity");
    expect(normalizeTitle("Vikram (2022)")).toBe("vikram");
    expect(normalizeTitle("Leo (Tamil)")).toBe("leo");
    expect(normalizeTitle("Leo (Tamil film)")).toBe("leo");
    // …but an arbitrary parenthetical is NOT a disambiguator. Stripping it
    // would collapse a distinct edition onto the base title — a wrong merge.
    expect(normalizeTitle("Special (extended)")).toBe("special extended");
    expect(normalizeTitle("Special (extended)")).not.toBe(normalizeTitle("Special"));
  });

  it("🔒 sequels never collide with their base film", () => {
    expect(normalizeTitle("Pushpa")).not.toBe(normalizeTitle("Pushpa 2"));
    expect(normalizeTitle("Pushpa 2")).toBe("pushpa 2");
    expect(normalizeTitle("Pushpa 2: The Rule")).toBe("pushpa 2 the rule");
    expect(normalizeTitle("KGF Chapter 1")).not.toBe(normalizeTitle("KGF Chapter 2"));
    expect(normalizeTitle("KGF Chapter 1")).toBe("kgf chapter 1");
  });
});

describe("normalizeTitle — edges", () => {
  it("empty and all-punctuation collapse to empty string", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle("!!!")).toBe("");
    expect(normalizeTitle("...")).toBe("");
    expect(normalizeTitle("()[]{}")).toBe("");
  });

  it("peels MULTIPLE trailing parentheticals", () => {
    expect(normalizeTitle("Title (2024) (film)")).toBe("title");
  });

  it("Indic-script titles: combining marks (\\p{M}) drop, base letters survive (deterministic, lossy — intentional for now)", () => {
    // Not transliterated; cross-net matching for Indic titles leans on the
    // Latin form TMDb/Wikipedia carry. Pinned so the behavior can't drift
    // silently — improving it (an LLM transliteration matcher) is deferred.
    expect(normalizeTitle("మహానటి")).toBe("మహ నట");
    expect(normalizeTitle("बाहुबली")).toBe("ब ह बल");
    // Stable across calls and always trimmed/lowercased.
    const out = normalizeTitle("మహానటి");
    expect(out).toBe(out.trim());
    expect(normalizeTitle("మహానటి")).toBe(out);
  });

  it("a very long title does not throw and stays normalized", () => {
    const long = `${"A".repeat(500)} ${"B".repeat(500)}`;
    const out = normalizeTitle(long);
    expect(out).toBe(`${"a".repeat(500)} ${"b".repeat(500)}`);
  });

  it("a punctuation string containing & yields the lone token 'and' (current behavior)", () => {
    expect(normalizeTitle("@#$ %^&*")).toBe("and");
  });
});
