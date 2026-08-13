// COPY GUARD — POSSESSIVE TERMINATION (Issue 041).
//
// A live Wed Drop run 2-strike DROPPED "Batwara 1947" — green, gate-approved,
// A.R. Rahman scoring, Sunny Deol and Aamir Khan on the poster — on a single
// flag: "Rajkumar Santoshi's Partition". Rajkumar Santoshi is the film's
// director and sits in the allowlist; CAP_WORD treats "Santoshi's" as an
// ordinary capitalised word, so the greedy 3-word window fused the man with the
// noun he owned and {rajkumar, santoshi, partition} backed nobody.
//
// These pin the extraction fix. The strike count, the drop behaviour and the
// allowlist source are deliberately NOT exercised here — they were correct.
import { describe, it, expect } from "vitest";
import {
  buildAllowlist,
  nameCandidates,
  scanText,
  sweepNames,
  terminatePossessives,
} from "../copy-guard.js";

/** Issue 041's real theatrical backing data, trimmed to what the sweep reads. */
const allow = buildAllowlist({
  personNames: ["Rajkumar Santoshi", "Aamir Khan", "Sunny Deol", "Preity Zinta", "A.R. Rahman"],
  nonPersonText: ["Batwara 1947", "Hindi"],
  nonPersonWords: ["the", "and", "with", "in", "on", "a", "is", "scored", "by"],
});

describe("terminatePossessives — the run ends where the possessive does", () => {
  it("breaks the space between a possessive and the noun it owns", () => {
    expect(terminatePossessives("Rajkumar Santoshi's Partition epic"))
      .toBe("Rajkumar Santoshi's\nPartition epic");
  });

  it("handles the curly apostrophe the LLM actually emits", () => {
    expect(terminatePossessives("Rajkumar Santoshi’s Partition"))
      .toBe("Rajkumar Santoshi’s\nPartition");
  });

  it("does NOT fire when the possessive owns a lowercase noun — that run already ended", () => {
    const s = "Govindh Vasantha's music seals the mood";
    expect(terminatePossessives(s)).toBe(s);
  });

  it("is length-preserving, so the offset contract still holds", () => {
    for (const s of [
      "Rajkumar Santoshi's Partition epic leads the weekend.",
      "Christopher Nolan's Oppenheimer returns to IMAX.",
      "A.R. Rahman's Partition score anchors it.",
      "Govindh Vasantha's music seals it.",
    ]) {
      expect(scanText(s).length, s).toBe(s.length);
    }
  });

  it("composes with the other two rewrites without breaking length", () => {
    const s = "Director Rajkumar Santoshi's Partition epic. Music Director A.R. Rahman scores.";
    expect(scanText(s).length).toBe(s.length);
  });
});

describe("the Issue 041 flag is clean now", () => {
  it("\"Rajkumar Santoshi's Partition\" — possessive fused to the owned noun", () => {
    expect(sweepNames("Rajkumar Santoshi's Partition epic leads the weekend.", allow)).toEqual([]);
  });

  it("the real caption opener sweeps clean end to end", () => {
    const caption =
      "Aamir Khan and Sunny Deol in the same Partition frame — Rajkumar Santoshi's " +
      "Batwara 1947, scored by A.R. Rahman, is THE theatre event of the weekend.";
    expect(sweepNames(caption, allow)).toEqual([]);
  });

  it("the candidate stops at the person and never reaches the owned noun", () => {
    const cands = [...nameCandidates("Rajkumar Santoshi's Partition epic")];
    expect(cands).toContain("Rajkumar Santoshi's");
    expect(cands.some((c) => c.includes("Partition"))).toBe(false);
  });

  it("labels are still sliced from the ORIGINAL — no injected newline escapes", () => {
    const text = "Rajkumar Santoshi's Partition epic. Director Prakash Raj anchors it.";
    for (const c of nameCandidates(text)) {
      expect(c).not.toContain("\n");
      expect(text).toContain(c);
    }
  });
});

describe("the general possessive shape, not just Batwara", () => {
  const western = buildAllowlist({
    personNames: ["Christopher Nolan", "Cillian Murphy"],
    nonPersonText: ["Oppenheimer", "Dark Knight"],
    nonPersonWords: ["the", "and", "returns", "to", "in"],
  });

  it("\"Christopher Nolan's Oppenheimer\" is clean when the person is allowlisted", () => {
    expect(sweepNames("Christopher Nolan's Oppenheimer returns to IMAX.", western)).toEqual([]);
  });

  it("a possessive owning a TWO-word title is clean when the title is in film data", () => {
    expect(sweepNames("Christopher Nolan's Dark Knight returns.", western)).toEqual([]);
  });

  it("SHARP EDGE: the owned noun is now judged on its OWN, so a multi-word phrase absent from film data flags separately", () => {
    // Terminating the run means the owned thing is no longer swallowed by the
    // person-run — it becomes its own candidate. Harmless in the pillar paths,
    // where every film title reaches nonPersonText via Release.title, but it
    // means this change can MOVE a flag rather than clear it. Documented, not
    // incidental: a single capitalised noun ("Partition") is never captured
    // (NGRAM_RE needs 2+ words), so the Issue 041 shape stays clean either way.
    const bare = buildAllowlist({
      personNames: ["Christopher Nolan"],
      nonPersonText: [],
      nonPersonWords: ["the", "returns"],
    });
    expect(sweepNames("Christopher Nolan's Dark Knight returns.", bare)).toEqual(["Dark Knight"]);
    expect(sweepNames("Christopher Nolan's Partition returns.", bare)).toEqual([]);
  });

  it("an initials-name possessive survives — \"A.R. Rahman's Partition\"", () => {
    expect(sweepNames("A.R. Rahman's Partition score anchors it.", allow)).toEqual([]);
  });
});

describe("the guard did NOT get looser — unbacked names still flag", () => {
  it("a fully unbacked possessive still flags", () => {
    expect(sweepNames("Fakename Person's Movie leads.", allow)).toContain("Fakename Person's");
  });

  it("an unbacked name owning a noun flags on the PERSON, not the noun", () => {
    const flags = sweepNames("Rajkumar Fakesurname's Partition epic.", allow);
    expect(flags).toEqual(["Rajkumar Fakesurname's"]);
  });

  it("a cross-person blend is still caught through a possessive", () => {
    // {aamir, deol} is a subset of NO single person's full name.
    expect(sweepNames("Aamir Deol's Partition epic.", allow)).toEqual(["Aamir Deol's"]);
  });

  it("a misspelling is still caught — shortening the run does not launder it", () => {
    expect(sweepNames("Rajkumarr Santoshi's Partition epic.", allow)).toEqual(["Rajkumarr Santoshi's"]);
  });

  it("a plain unbacked name with no possessive anywhere is untouched by this change", () => {
    // Trigger-single shape ("and Tabu", not followed by another capital) — the
    // classic Wed Drop hallucination catch, which this change must not soften.
    expect(sweepNames("Aamir Khan and Tabu are electric.", allow)).toEqual(["Tabu"]);
  });
});
