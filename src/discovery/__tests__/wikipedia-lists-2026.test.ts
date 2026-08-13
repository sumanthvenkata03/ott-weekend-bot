// WD-ENG-05 PART 3 — the real 2026 list pages, all eight pillar languages.
//
// Captured from data/cache.sqlite (the pages the live run actually parsed) and
// frozen under fixtures/wikipedia/lists-2026/. NO NETWORK: these are plain file
// reads driving parsePage directly.
//
// Only the "Opening" date tables were kept — those are the sole tables parsePage
// reads (`firstHeader.startsWith("opening")`), so the extraction is faithful and
// the fixture set is 506KB instead of 2.8MB. Every count below was verified
// identical against the full cached page before trimming.
//
// ── WHAT THIS FILE IS REALLY FOR ────────────────────────────────────────────
// The packet that produced it expected a broken Kannada parser and a Telugu row
// swallowed silently. Neither existed. What these pins protect is the thing that
// made both look plausible: until now the only per-language signal was "N in
// range", so a working parser over a quiet week and a parser reading nothing
// were the same number. These fixtures make a real regression impossible to
// mistake for a quiet week, in either direction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parsePage } from "../sources/wikipediaList.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures", "wikipedia", "lists-2026");

const load = (lang: string) => readFileSync(join(DIR, `${lang.toLowerCase()}-2026.html`), "utf8");
const parseFor = (lang: string, from: string, to: string) =>
  parsePage(load(lang), lang, 2026, `List of ${lang} films of 2026`, from, to);

const FULL_YEAR = ["2026-01-01", "2026-12-31"] as const;
/** The real Wed Drop windows for Issue 042. */
const THEATRICAL = ["2026-08-12", "2026-08-16"] as const;
const OTT = ["2026-08-10", "2026-08-16"] as const;

// ── THE PINS ────────────────────────────────────────────────────────────────
// rowsSeen = resolved + blank + unparsed, per language, for the whole year.
// `unparsed` is 0 everywhere: nothing on any of these pages is being lost.
interface Pin {
  lang: string; rowsSeen: number; resolved: number; blank: number; unparsed: number;
  year: number; theatrical: number; ott: number;
}
const PINS: Pin[] = [
  { lang: "Telugu",    rowsSeen: 129, resolved: 129, blank: 0, unparsed: 0, year: 129, theatrical: 4, ott: 4 },
  { lang: "Tamil",     rowsSeen: 122, resolved: 121, blank: 1, unparsed: 0, year: 121, theatrical: 2, ott: 2 },
  { lang: "Malayalam", rowsSeen: 137, resolved: 137, blank: 0, unparsed: 0, year: 137, theatrical: 1, ott: 1 },
  { lang: "Kannada",   rowsSeen: 142, resolved: 142, blank: 0, unparsed: 0, year: 142, theatrical: 0, ott: 0 },
  { lang: "Hindi",     rowsSeen: 121, resolved: 121, blank: 0, unparsed: 0, year: 121, theatrical: 2, ott: 2 },
  { lang: "Marathi",   rowsSeen:  55, resolved:  52, blank: 3, unparsed: 0, year:  52, theatrical: 1, ott: 1 },
  { lang: "Punjabi",   rowsSeen:   0, resolved:   0, blank: 0, unparsed: 0, year:   0, theatrical: 0, ott: 0 },
];

describe("PART 3 — per-language row counts across all eight pillar languages", () => {
  it.each(PINS)("$lang — $year films for 2026, $rowsSeen rows seen", (p) => {
    const t = parseFor(p.lang, ...FULL_YEAR);
    expect(t.rowsSeen).toBe(p.rowsSeen);
    expect(t.resolved).toBe(p.resolved);
    expect(t.blank).toBe(p.blank);
    expect(t.unparsed).toEqual([]);            // names, not a count — nothing lost
    expect(t.films.length).toBe(p.year);
    // The arithmetic must close: every row is accounted for, by construction.
    expect(t.resolved + t.blank + t.unparsed.length).toBe(t.rowsSeen);
  });

  it.each(PINS)("$lang — window yields are pinned too ($theatrical theatrical / $ott ott)", (p) => {
    expect(parseFor(p.lang, ...THEATRICAL).films.length).toBe(p.theatrical);
    expect(parseFor(p.lang, ...OTT).films.length).toBe(p.ott);
  });

  it("NO language loses a single row anywhere on its page", () => {
    const lost = PINS.flatMap((p) => parseFor(p.lang, ...FULL_YEAR).unparsed.map((r) => `${p.lang}: ${r}`));
    expect(lost).toEqual([]);
  });
});

describe("PART 3 — the two films the packet named", () => {
  it("Panchali Panchabhartruka IS parsed from the Telugu list, dated from day cell 14", () => {
    // The packet's premise was that this row was swallowed by the parser. It is
    // not: it parses, it is dated 2026-08-14, and it falls INSIDE both windows.
    // Its actual disappearance happens downstream, at candidates.ts/matchesIntent,
    // which drops wiki-only finds (no TMDb match ⇒ no releaseType) — by design,
    // and now with a log line naming them.
    const year = parseFor("Telugu", ...FULL_YEAR).films;
    const hit = year.find((f) => f.title === "Panchali Panchabhartruka");
    expect(hit, "Panchali Panchabhartruka must parse off the Telugu list").toBeDefined();
    expect(hit!.releaseDate).toBe("2026-08-14");
    expect(hit!.approximateDate).toBeUndefined();      // a concrete day, not a month fallback
    expect(hit!.language).toBe("Telugu");

    // Both windows spelled out rather than spread from an array — a `readonly
    // [string, string]` loses its tuple-ness inside an array literal, which is
    // what TS2556 was objecting to.
    expect(parseFor("Telugu", ...THEATRICAL).films.map((f) => f.title)).toContain("Panchali Panchabhartruka");
    expect(parseFor("Telugu", ...OTT).films.map((f) => f.title)).toContain("Panchali Panchabhartruka");
  });

  it("Chargesheet 03-08 is ABSENT from the cached Kannada 2026 page entirely", () => {
    // Stated plainly, as the packet asked: its recovery was hoped, never
    // promised. The string does not occur in the page, so no parser change of
    // any kind could surface it — it is a Wikipedia list gap, not a parse gap.
    expect(load("Kannada")).not.toMatch(/chargesheet/i);
    expect(parseFor("Kannada", ...FULL_YEAR).films.map((f) => f.title).join("|"))
      .not.toMatch(/chargesheet/i);
  });
});

describe("PART 3 — the Kannada alarm, explained by the fixtures", () => {
  it("the page parses 142 films for the year — the parser was never broken", () => {
    const y = parseFor("Kannada", ...FULL_YEAR);
    expect(y.films.length).toBe(142);
    expect(y.resolved).toBe(142);
    expect(y.unparsed).toEqual([]);
  });

  it("…and genuinely has NO film in the Issue-042 window", () => {
    expect(parseFor("Kannada", ...THEATRICAL).films).toEqual([]);
    expect(parseFor("Kannada", ...OTT).films).toEqual([]);
  });

  it("the nearest Kannada releases straddle the window — Aug 6/7, then Aug 26", () => {
    const aug = parseFor("Kannada", ...FULL_YEAR).films
      .filter((f) => (f.releaseDate ?? "").startsWith("2026-08"))
      .map((f) => `${f.releaseDate} ${f.title}`);
    expect(aug).toEqual([
      "2026-08-06 Life Today",
      "2026-08-07 Akshara",
      "2026-08-07 Ayogya 2",
      "2026-08-07 Boss",
      "2026-08-07 Detective Teekshana",
      "2026-08-07 Picture",
      "2026-08-26 Toxic",
    ]);
  });

  it("'September 21' — TMDb's Kannada hit that week — is not on the Wikipedia list at all", () => {
    // This is the whole of the cross-net discrepancy that raised the alarm: one
    // net had a film the other never listed.
    expect(parseFor("Kannada", ...FULL_YEAR).films.map((f) => f.title))
      .not.toContain("September 21");
  });
});

describe("PART 3 — blank rows are page furniture, not losses", () => {
  it("Tamil's 1 and Marathi's 3 skipped rows are empty month-header stubs", () => {
    // These are the rows the old bare `skipped` counter reported. They are
    // vertical-text month cells for months with no films yet ("D E C"), and they
    // are correctly classified as blank rather than warned about every run.
    for (const [lang, blanks] of [["Tamil", 1], ["Marathi", 3]] as const) {
      const t = parseFor(lang, ...FULL_YEAR);
      expect(t.blank).toBe(blanks);
      expect(t.unparsed).toEqual([]);
      expect(t.skipped).toBe(blanks);          // legacy field, semantics unchanged
    }
  });
});
