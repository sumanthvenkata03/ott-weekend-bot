// WD-ENG-01 PARTS 2 & 3 — the extraction fix and the ghost scrub, at unit level.
//
// PART 2. Issue 042's final run struck a green, gate-approved, platform-resolved
// film out of the deck on the phrase "Lights-off Malayalam". Nobody in that
// phrase is a person. CAP_WORD accepts an internal hyphen, so "Lights-off" read
// as one capitalised word, the 2-word window fused it with the language, and
// {lights, off} backed nobody. severHyphenLowercase ends that class at the
// source; "Abdul-Jabbar" (capital after the hyphen) is untouched.
//
// PART 3. When a drop IS correct, every other surface has to stop referring to
// the film. Fixtures are the REAL Aug-13 caption and index body from
// output/runs/wed-drop-ott-2026-08-13-draft.json, plus the Issue 041 Batwara
// shape (theatrical index, "•"-separated).
import { describe, it, expect } from "vitest";
import {
  buildAllowlist,
  mentionsTitle,
  nameCandidates,
  retargetCounts,
  scanText,
  scrubDroppedFilms,
  scrubIndexBody,
  severHyphenLowercase,
  sweepNames,
  type NameAllowlist,
} from "../copy-guard.js";
import { WED_DROP_NON_PERSON_WORDS } from "../../content/weekend/wednesday-drop.js";

// ── The REAL Aug-13 OTT allowlist ───────────────────────────────────────────
// Name fields verbatim from the final run's reconciled records, so this is the
// allowlist the live guard actually held when it struck Aroopi.
const AUG13_PEOPLE = [
  "Neha Chawla", "Vysakh Ravi", "Gopi Sundar",              // Aroopi
  "Antony Varghese", "Ravi Basrur",                          // Kattalan
  "Sanjay Dutt",                                             // Aakhri Sawal
  "Kriti Sanon", "Shahid Kapoor", "Homi Adajania", "Pritam Chakraborty", // Cocktail 2
  "Kangana Ranaut",                                          // Bharat Bhhagya Viddhaata
  "Madonna Sebastian", "Sananth", "Rajesh Murugesan",        // Heartin
  "Vaani Kapoor", "Ishwak Singh",                            // Sarvagunn Sampann
];
const AUG13_FILLER = [
  "Aroopi", "Kattalan", "Aakhri Sawal", "Cocktail 2", "Heartin",
  "Bharat Bhhagya Viddhaata", "Sarvagunn Sampann",
  "Malayalam", "Hindi", "Tamil",
  "Prime Video", "ManoramaMAX", "Lionsgate Play", "Netflix", "ZEE5",
];
const AUG13: NameAllowlist = buildAllowlist({
  personNames: AUG13_PEOPLE,
  nonPersonText: AUG13_FILLER,
  nonPersonWords: WED_DROP_NON_PERSON_WORDS,
});

describe("PART 2 — a hyphen followed by a lowercase letter is not a name token", () => {
  it("THE FIXTURE: the exact phrase that struck Aroopi produces zero violations", () => {
    expect(sweepNames("Lights-off Malayalam horror done right.", AUG13)).toEqual([]);
  });

  it.each([
    ["Lights-off Malayalam horror done right."],
    ["Coming-of-age Malayalam drama, quietly devastating."],
    ["Must-watch Malayalam horror for the weekend."],
    ["Slow-burn Malayalam dread that earns its ending."],
    ["Edge-of-seat Tamil thriller."],
    ["A Lights-off Prime Video pick."],
  ])("compound modifier is invisible to the sweep: %s", (text) => {
    expect(sweepNames(text, AUG13)).toEqual([]);
  });

  it("the token cannot START, JOIN or EXTEND a run — it is removed, not merely filtered", () => {
    // START: nothing left to anchor a 2-word window.
    expect(nameCandidates("Lights-off Malayalam")).toEqual(new Set());
    // JOIN: the two capitals on either side must not fuse across it.
    expect(nameCandidates("Kerala Must-watch Horror")).toEqual(new Set());
    // EXTEND: a real backed name beside one is still found, and still backed.
    expect(sweepNames("Lights-off Malayalam horror, scored by Gopi Sundar.", AUG13)).toEqual([]);
    expect(nameCandidates("Must-watch Gopi Sundar score")).toEqual(new Set(["Gopi Sundar"]));
  });

  it("a CAPITAL after the hyphen keeps the token a full name token", () => {
    // Abdul-Jabbar is nobody in this edition's data, so it MUST still flag —
    // proof the token is being examined, not skipped.
    expect(sweepNames("Kareem Abdul-Jabbar turns up in the third act.", AUG13))
      .toEqual(["Kareem Abdul-Jabbar"]);
    expect(severHyphenLowercase("Kareem Abdul-Jabbar")).toBe("Kareem Abdul-Jabbar");
    // …and it is subject to the SAME strict backing: add him and he passes.
    const withHim = buildAllowlist({
      personNames: [...AUG13_PEOPLE, "Kareem Abdul-Jabbar"],
      nonPersonText: AUG13_FILLER,
      nonPersonWords: WED_DROP_NON_PERSON_WORDS,
    });
    expect(sweepNames("Kareem Abdul-Jabbar turns up in the third act.", withHim)).toEqual([]);
  });

  it("THE GUARD DID NOT GO SOFT — every prior class still flags", () => {
    // Part 2 keys on token SHAPE, so an unbacked person with no hyphen is
    // untouched, and so is a 2-word capitalised run with no hyphen at all.
    expect(sweepNames("Pritam scores it, and Tabu steals every scene.", AUG13)).toEqual(["Tabu"]);
    expect(sweepNames("Slow Burn Malayalam horror done right.", AUG13)).toEqual(["Slow Burn Malayalam"]);
    // A cross-person blend is still not backed by any ONE person.
    expect(sweepNames("Vaani Singh carries the film.", AUG13)).toEqual(["Vaani Singh"]);
  });

  it("LENGTH INVARIANT — the scan copy still maps 1:1 onto the original", () => {
    for (const s of [
      "Lights-off Malayalam horror done right.",
      "Coming-of-age. Must-watch Kerala Horror",
      "Kareem Abdul-Jabbar and Rajkumar Santoshi's Partition epic.",
      "A.R. Rahman scores the Slow-burn thriller.",
      "",
    ]) {
      expect(scanText(s).length, JSON.stringify(s)).toBe(s.length);
      expect(severHyphenLowercase(s).length, JSON.stringify(s)).toBe(s.length);
    }
  });

  it("LABELS STILL COME FROM THE ORIGINAL — no scan-copy newline can leak out", () => {
    for (const c of nameCandidates("Must-watch Kareem Abdul-Jabbar in a Slow-burn epic.")) {
      expect(c).not.toContain("\n");
    }
  });
});

describe("PART 3 — count retargeting", () => {
  it("rewrites the count word and preserves its casing", () => {
    expect(retargetCounts("Seven drops, every platform sorted.", 6))
      .toBe("Six drops, every platform sorted.");
    expect(retargetCounts("seven films this week", 6)).toBe("six films this week");
    expect(retargetCounts("SEVEN DROPS", 6)).toBe("SIX DROPS");
    expect(retargetCounts("Seven fresh releases", 6)).toBe("Six fresh releases");
  });

  it("leaves numbers that are NOT counting Wed Drop nouns alone", () => {
    expect(retargetCounts("Two brothers, one betrayal.", 6)).toBe("Two brothers, one betrayal.");
    expect(retargetCounts("A seven-year silence.", 6)).toBe("A seven-year silence.");
  });
});

describe("PART 3 — mentionsTitle is whole-phrase, case-insensitive", () => {
  it.each([
    ["Aroopi unleashes a Yakshini scare.", "Aroopi", true],
    ["aroopi is the one to start with", "Aroopi", true],
    ["Batwara 1947 opens Friday.", "Batwara 1947", true],
    ["Aroopistan is not a film.", "Aroopi", false],
    ["Six drops this week.", "Aroopi", false],
  ])("%s ∋ %s → %s", (text, title, want) => {
    expect(mentionsTitle(text, title)).toBe(want);
  });
});

describe("PART 3 — THE AROOPI GHOST (the real Aug-13 caption + index)", () => {
  // Verbatim from output/runs/wed-drop-ott-2026-08-13-draft.json. This caption
  // shipped alongside SIX cards while naming Aroopi and claiming "Seven drops".
  const CAPTION =
    "Sanjay Dutt walks into a televised 'intellectual trial' and the whole country's watching — " +
    "Aakhri Sawal is the week's only rated drop (6.3) and the one to start with, on Lionsgate Play. " +
    "Over on Netflix, Homi Adajania reboots the rom-com with Cocktail 2: Kriti Sanon and Shahid Kapoor " +
    "stuck in a love triangle that goes gloriously off-script. Kangana Ranaut holds a hospital together " +
    "through the 26/11 chaos in Bharat Bhhagya Viddhaata. The South carries the mood — Kattalan brings " +
    "Malayalam ivory-cartel carnage (KGF's Ravi Basrur on score), Aroopi unleashes a proper Yakshini " +
    "scare, and Tamil's Heartin is your easy rom-com night. Seven drops, every platform sorted. " +
    "Save this for the weekend. Which one are you starting with? 👇";
  const INDEX = [
    "Aakhri Sawal (Hindi) → Lionsgate Play",
    "Cocktail 2 (Hindi) → Netflix",
    "Bharat Bhhagya Viddhaata (Hindi) → ZEE5",
    "Kattalan (Malayalam) → ManoramaMAX",
    "Aroopi (Malayalam) → Prime Video",
    "Heartin (Tamil) → Prime Video",
    "Sarvagunn Sampann (Hindi) → ZEE5",
  ].join("\n");

  const scrub = scrubDroppedFilms(CAPTION, INDEX, ["Aroopi"], 6);

  it("certifies clean", () => {
    expect(scrub.problems).toEqual([]);
    expect(scrub.clean).toBe(true);
  });

  it("the caption no longer names the dropped film", () => {
    expect(scrub.caption).not.toContain("Aroopi");
    expect(mentionsTitle(scrub.caption, "Aroopi")).toBe(false);
  });

  it("the caption no longer overcounts", () => {
    expect(scrub.caption).not.toContain("Seven drops");
    expect(scrub.caption).toContain("Six drops");
  });

  it("the index lists exactly the six surviving films, in order", () => {
    expect(scrub.indexBody.split("\n")).toEqual([
      "Aakhri Sawal (Hindi) → Lionsgate Play",
      "Cocktail 2 (Hindi) → Netflix",
      "Bharat Bhhagya Viddhaata (Hindi) → ZEE5",
      "Kattalan (Malayalam) → ManoramaMAX",
      "Heartin (Tamil) → Prime Video",
      "Sarvagunn Sampann (Hindi) → ZEE5",
    ]);
  });

  it("exactly ONE sentence is removed — the rest of the caption is byte-identical", () => {
    expect(scrub.caption).toContain("Sanjay Dutt walks into a televised 'intellectual trial'");
    expect(scrub.caption).toContain("Over on Netflix, Homi Adajania reboots the rom-com");
    expect(scrub.caption).toContain("Save this for the weekend.");
    expect(scrub.caption).toContain("Which one are you starting with? 👇");
    for (const kept of ["Aakhri Sawal", "Cocktail 2", "Bharat Bhhagya Viddhaata"]) {
      expect(mentionsTitle(scrub.caption, kept), kept).toBe(true);
    }
  });

  // THE COLLATERAL, STATED. The real caption sells Kattalan, Aroopi and Heartin
  // in ONE sentence ("The South carries the mood — …"), so removing Aroopi's
  // reference removes its sentence-mates' caption mentions too. That is the
  // honest cost of a DETERMINISTIC scrub: clause surgery cannot be done without
  // risking broken grammar, and a caption that reads badly is worse than one
  // that mentions five of six films.
  //
  // What matters is that nothing becomes FALSE: the collateral films keep their
  // cards, keep their index lines, and the count word tracks the CARD count —
  // not the number of films the caption happens to name.
  it("sentence-mates of the dropped film lose their caption mention but keep everything else", () => {
    for (const mate of ["Kattalan", "Heartin"]) {
      expect(mentionsTitle(scrub.caption, mate), mate).toBe(false);
      expect(mentionsTitle(scrub.indexBody, mate), mate).toBe(true);
    }
    expect(scrub.caption).toContain("Six drops");   // the CARD count, still right
    expect(scrub.clean).toBe(true);
  });
});

describe("PART 3 — THE BATWARA GHOST (Issue 041 shape: theatrical, • -separated index)", () => {
  const CAPTION =
    "Five films open in cinemas this weekend. Batwara 1947 is Rajkumar Santoshi's Partition epic. " +
    "Awarapan 2 brings Emraan Hashmi back. Magudam is the Tamil action pick.";
  const INDEX =
    "Batwara 1947 (Hindi) → In cinemas • Awarapan 2 (Hindi) → In cinemas • " +
    "Magudam (Tamil) → In cinemas • Vishwanath & Sons (Tamil) → In cinemas";

  const scrub = scrubDroppedFilms(CAPTION, INDEX, ["Batwara 1947"], 3);

  it("certifies clean and leaves no trace of the dropped film", () => {
    expect(scrub.problems).toEqual([]);
    expect(scrub.clean).toBe(true);
    expect(mentionsTitle(scrub.caption, "Batwara 1947")).toBe(false);
    expect(mentionsTitle(scrub.indexBody, "Batwara 1947")).toBe(false);
  });

  it("retargets the count to the rendered card count", () => {
    expect(scrub.caption).not.toContain("Five films");
    expect(scrub.caption).toContain("Three films");
  });

  it("rejoins the • -separated index with its own separator", () => {
    expect(scrub.indexBody).toBe(
      "Awarapan 2 (Hindi) → In cinemas • Magudam (Tamil) → In cinemas • Vishwanath & Sons (Tamil) → In cinemas"
    );
  });

  it("scrubIndexBody handles both separators", () => {
    expect(scrubIndexBody("A → x\nB → y", ["A"])).toBe("B → y");
    expect(scrubIndexBody("A → x • B → y", ["A"])).toBe("B → y");
  });
});

describe("PART 3 — the scrub REFUSES to certify what it cannot prove", () => {
  it("reports failure when the whole caption was about the dropped film", () => {
    const r = scrubDroppedFilms("Aroopi is the only reason to stream this week.", "Kattalan → ManoramaMAX", ["Aroopi"], 1);
    expect(r.clean).toBe(false);
    expect(r.problems).toContain("caption scrubbed empty");
  });

  it("reports failure when the index would be emptied", () => {
    const r = scrubDroppedFilms("Kattalan leads the week.", "Aroopi (Malayalam) → Prime Video", ["Aroopi"], 1);
    expect(r.clean).toBe(false);
    expect(r.problems).toContain("index slide scrubbed empty");
  });

  it("reports failure when the target count exceeds the number-word table", () => {
    // Unreachable in production (MAX_WED_DROP_FILMS is 15) and kept as a
    // tripwire: if the cap is ever raised past the table, the scrub refuses to
    // certify rather than silently leaving a wrong number in the caption.
    const r = scrubDroppedFilms("Aroopi is out. Seven drops this week.", "Kattalan → x", ["Aroopi"], 25);
    expect(r.clean).toBe(false);
    expect(r.problems.join(" ")).toContain("exceeds the number-word table");
  });

  it("a model-written count ABOVE the film cap is still recognised and retargeted", () => {
    // The table runs to twenty precisely so this is seen rather than skipped.
    const r = scrubDroppedFilms(
      "Aroopi leads. Sixteen drops this week.", "Kattalan → x • Heartin → y", ["Aroopi"], 2
    );
    expect(r.caption).toContain("Two drops");
    expect(r.caption).not.toContain("Sixteen");
    expect(r.clean).toBe(true);
  });

  it("a title surviving in an un-sentence-able caption is reported, not swallowed", () => {
    // No sentence punctuation at all, so nothing can be removed piecewise.
    const r = scrubDroppedFilms("Aroopi and Kattalan", "Kattalan → x", ["Aroopi"], 1);
    expect(r.clean).toBe(false);
    expect(r.problems.some((p) => p.includes('caption still names "Aroopi"') || p === "caption scrubbed empty")).toBe(true);
  });
});
