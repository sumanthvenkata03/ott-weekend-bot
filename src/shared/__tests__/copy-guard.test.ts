// COPY-GUARD — the shared Name Sweep, and the Issue 032 extraction repair.
//
// Issue 032's OTT edition 2-strike DROPPED "Chinna Chinna Aasai" on four flags,
// none of which was a real violation. The POLICY was right; the EXTRACTION fed
// it garbage. These tests pin both halves of the repair and — the part that
// actually matters — pin that the repair did not loosen the guard.
//
// THE LOAD-BEARING TESTS ARE THE MUTATION TESTS. A repair to a hallucination
// guard is only safe if a genuine hallucination still trips it through every new
// code path, so there is one mutation case per path. If you are here because one
// of them went red: the guard has been weakened, not the test.
import { describe, it, expect } from "vitest";
import {
  buildAllowlist,
  isPersonBacked,
  nameCandidates,
  nameTokens,
  neutralizeRoleTitles,
  personTokens,
  scanText,
  segmentSentences,
  sweepNames,
} from "../copy-guard.js";

/** The Issue 032 OTT edition's real backing data, trimmed to what the sweep reads. */
const allow = buildAllowlist({
  personNames: ["Chidambaram", "Govindh Vasantha", "Indrans", "Madhoo", "Aparna Balamurali"],
  nonPersonText: ["Side Heroes", "Chinna Chinna Aasai", "JioHotstar", "Malayalam"],
  nonPersonWords: ["the", "and", "with", "on", "netflix", "five", "not", "streaming"],
});

// ── (a) SENTENCE SEGMENTATION ────────────────────────────────────────────────
describe("segmentSentences — a candidate may never straddle a sentence end", () => {
  it("breaks after a real sentence", () => {
    expect(segmentSentences("Side Heroes. Five films land.")).toBe("Side Heroes.\nFive films land.");
  });

  it("breaks on ! and ? and after a closing quote", () => {
    expect(segmentSentences("Superb! Five films")).toBe("Superb!\nFive films");
    expect(segmentSentences("Really? Five films")).toBe("Really?\nFive films");
    expect(segmentSentences('He said "brilliant." Five films')).toBe('He said "brilliant."\nFive films');
  });

  it("does NOT break a single-letter initial — \"S. Shankar\" is one name", () => {
    expect(segmentSentences("S. Shankar directs.")).toBe("S. Shankar directs.");
  });

  it("does NOT break a multi-initial — \"A.R. Rahman\" is one name", () => {
    expect(segmentSentences("A.R. Rahman scores it.")).toBe("A.R. Rahman scores it.");
  });

  it("does NOT break an honorific — breaking it would HIDE a violation", () => {
    expect(segmentSentences("Dr. Rajkumar sings.")).toBe("Dr. Rajkumar sings.");
    expect(segmentSentences("Mr. Bachchan arrives.")).toBe("Mr. Bachchan arrives.");
  });

  it("leaves text with no sentence boundary untouched", () => {
    const s = "Govindh Vasantha's music seals the mood";
    expect(segmentSentences(s)).toBe(s);
  });
});

// ── (b) ROLE-TITLE NEUTRALISATION ───────────────────────────────────────────
describe("neutralizeRoleTitles — a role title is not part of the name", () => {
  it("blanks a prefixing role word to equal-length newlines", () => {
    expect(neutralizeRoleTitles("Director Chidambaram")).toBe("\n".repeat(8) + " Chidambaram");
  });

  it("blanks a run of them", () => {
    expect(neutralizeRoleTitles("Music Director Aparna")).toBe("\n".repeat(5) + " " + "\n".repeat(8) + " Aparna");
  });

  it("leaves a TRAILING role word alone — it still counts as part of the run", () => {
    expect(neutralizeRoleTitles("Fakename Director")).toBe("Fakename Director");
  });

  it("does NOT touch honorifics (see the 🔴 note on ROLE_PREFIXES)", () => {
    expect(neutralizeRoleTitles("Dr. Chidambaram")).toBe("Dr. Chidambaram");
    expect(neutralizeRoleTitles("Mr. Bachchan")).toBe("Mr. Bachchan");
  });
});

// ── THE OFFSET CONTRACT ─────────────────────────────────────────────────────
describe("scanText is length-preserving, so offsets map 1:1 onto the original", () => {
  const SAMPLES = [
    "Side Heroes. Five films land this week.",
    "Music Director Aparna Vasantha leads.",
    "A.R. Rahman scores it. Dr. Rajkumar sings. Director Chidambaram returns.",
    "Aparna Balamurali and Indrans in a drama. Govindh Vasantha's music seals it.",
  ];
  for (const s of SAMPLES) {
    it(`same length: ${JSON.stringify(s.slice(0, 34))}`, () => {
      expect(scanText(s).length).toBe(s.length);
    });
  }
});

describe("labels are sliced from the ORIGINAL text, never from the scan copy", () => {
  it("no candidate ever carries an injected newline or a blanked role word", () => {
    const text = "Music Director Aparna Vasantha leads. Side Heroes. Prakash Raj anchors it.";
    for (const c of nameCandidates(text)) {
      expect(c).not.toContain("\n");
      expect(text).toContain(c); // provably a substring of the original
    }
  });

  it("the reported label is the real name, not the role-prefixed span", () => {
    expect(sweepNames("Director Prakash Raj shot it.", allow)).toEqual(["Prakash Raj"]);
  });
});

// ── THE FOUR ISSUE-032 FALSE POSITIVES ──────────────────────────────────────
describe("the Issue 032 flags are all clean now", () => {
  it("\"Side Heroes. Five\" — film title across a period", () => {
    expect(sweepNames("Side Heroes. Five films land this week.", allow)).toEqual([]);
  });

  it("\"Netflix. Not\" — platform across a period", () => {
    expect(sweepNames("Streaming on Netflix. Not the theatrical cut.", allow)).toEqual([]);
  });

  it("\"Director Chidambaram\" — role prefix on a real credit", () => {
    expect(sweepNames("Director Chidambaram returns to the well.", allow)).toEqual([]);
  });

  it("the real card-02 why-line sweeps clean end to end", () => {
    const why =
      "Aparna Balamurali and Indrans in a Varanasi-set drama where a chance meeting " +
      "slips quietly past friendship. Govindh Vasantha's music seals the mood.";
    expect(sweepNames(why, allow)).toEqual([]);
  });
});

// ── MUTATION TESTS — one per code path ──────────────────────────────────────
describe("MUTATION — a genuinely unbacked name is STILL flagged", () => {
  it("plain unbacked two-word name (baseline path)", () => {
    expect(sweepNames("A career-best turn from Prakash Raj.", allow).join("|")).toContain("Prakash Raj");
  });

  it("unbacked name AFTER a sentence break — segmentation must not hide it", () => {
    expect(sweepNames("Side Heroes. Prakash Raj anchors it.", allow)).toContain("Prakash Raj");
  });

  it("unbacked name BEHIND a role prefix — neutralisation must not hide it", () => {
    expect(sweepNames("Director Prakash Raj shot it.", allow)).toContain("Prakash Raj");
  });

  it("unbacked name behind an HONORIFIC stays flagged (the no-break exception)", () => {
    // If segmentSentences or neutralizeRoleTitles ever handled "Dr.", this name
    // would become a lone capital that no extractor captures — and vanish.
    expect(sweepNames("Dr. Prakashraj signed on.", allow).length).toBeGreaterThan(0);
  });

  it("a MISSPELLED real credit is still flagged (strict subset backing intact)", () => {
    // {govind, vasanthan} ⊄ {govindh, vasantha} — the letters matter.
    expect(sweepNames("Govind Vasanthan scores it.", allow)).toContain("Govind Vasanthan");
  });

  it("a cross-person blend is still flagged (no union laundering)", () => {
    // {aparna, vasantha} is a subset of NO single person's full name.
    expect(sweepNames("Aparna Vasantha leads.", allow)).toContain("Aparna Vasantha");
  });

  // ── FOUNDING FIXTURE — Issue 032's guard hole ────────────────────────────
  //
  // This one case is why candidate-level role-stripping was REJECTED, and it is
  // the regression test for the whole incident.
  //
  // NGRAM_RE captures at most 3 capitalised words and is greedy, so this string
  // yields the single candidate "Music Director Aparna" — `Vasantha` is never
  // examined. With the role words left in the tuple, {music,director,aparna}
  // backs nobody and the run is flagged: the role words were ACCIDENTALLY
  // LOAD-BEARING. Strip them from the CANDIDATE and {aparna} backs a real
  // person (Aparna Balamurali), so the cross-person blend "Aparna Vasantha"
  // sails straight through — a hallucinated name on a published card.
  //
  // Neutralising role titles in the SCAN TEXT instead slides the 3-word window
  // onto the real name, so the blend is caught AND the false positive is gone.
  //
  // WHAT MAKES THIS FAIL, verified by mutation rather than assumed: deleting
  // neutralizeRoleTitles from scanText() turns the candidate back into
  // "Music Director Aparna" and this goes red (along with 3 siblings). Note that
  // re-adding the candidate-level strip on TOP of the text-level one does NOT
  // trip it — by then the candidate is already "Aparna Vasantha", so there is no
  // role word left to strip. The hole only exists when candidate-level stripping
  // is the ONLY mechanism. This fixture therefore pins the OUTCOME — role words
  // must never launder a blend — not one implementation of it. Do not relax it.
  it("FOUNDING FIXTURE: \"Music Director Aparna Vasantha\" — role words must not launder a blend", () => {
    expect(sweepNames("Music Director Aparna Vasantha leads.", allow)).toContain("Aparna Vasantha");
  });
});

// ── COMPOSITION ─────────────────────────────────────────────────────────────
describe("personTokens / isPersonBacked still compose as before", () => {
  it("a pure-filler run reduces to nothing", () => {
    expect(personTokens("Side Heroes", allow)).toEqual([]);
  });

  it("a real name keeps its tokens", () => {
    expect(personTokens("Aparna Balamurali", allow)).toEqual(["aparna", "balamurali"]);
  });

  it("empty tokens are vacuously backed", () => {
    expect(isPersonBacked([], allow.persons)).toBe(true);
  });

  it("nameTokens still strips honorifics and sub-2-char tokens", () => {
    expect(nameTokens("Mr. A Bachchan")).toEqual(["bachchan"]);
  });
});
