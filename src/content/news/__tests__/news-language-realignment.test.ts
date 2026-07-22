// NEWS DESK — the LANGUAGE REALIGNMENT (Bengali out, Punjabi in) on the two
// sites that carried the split-brain beyond gather: content tagging and the
// india-scope gate. Pure: no API, no network.
import { describe, it, expect } from "vitest";
import { buildHashtags, packageLanguages } from "../news-caption.js";
import { INDIA_SCOPE_MARKERS, indiaScope } from "../news-score.js";
import type { ComposedEdition } from "../news-compose.js";

/** Minimal edition carrying one card with a given headline + query language. */
const edition = (headline: string, queryLanguage: string): ComposedEdition => ({
  format: "carousel",
  explodeFilms: false,
  why: "test",
  cover: null,
  cards: [{
    resolved: {
      story: { cluster: { id: "c1", headline, language: queryLanguage } },
      film: null, films: [], reason: "",
    },
  }],
  dropped: [],
} as unknown as ComposedEdition);

describe("packageLanguages — Punjabi can now earn its tag", () => {
  it("a Punjabi story is tagged from the copy", () => {
    // Before the realignment this returned [] — Punjabi was absent from
    // TAG_LANGUAGES, so a Punjabi package could not be tagged no matter what
    // the headline said.
    expect(packageLanguages(edition("Punjabi drama locks its OTT date", "Punjabi"))).toEqual(["Punjabi"]);
  });

  it("a Punjabi story earns #PunjabiCinema end-to-end", () => {
    expect(buildHashtags(edition("Punjabi drama locks its OTT date", "Punjabi"))).toContain("#PunjabiCinema");
  });

  it("the fallback path also admits Punjabi when the copy names no language", () => {
    expect(packageLanguages(edition("A film locks its OTT date", "Punjabi"))).toEqual(["Punjabi"]);
  });

  it("Bengali no longer earns a tag from either path", () => {
    expect(packageLanguages(edition("Bengali drama locks its OTT date", "Bengali"))).toEqual([]);
    expect(buildHashtags(edition("Bengali drama locks its OTT date", "Bengali"))).not.toContain("#BengaliCinema");
  });

  it("the other six are untouched", () => {
    for (const l of ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi"]) {
      expect(packageLanguages(edition(`${l} drama locks its OTT date`, l))).toEqual([l]);
    }
  });
});

describe("INDIA_SCOPE_MARKERS — 'bengali' is gone", () => {
  it("the marker list no longer contains it", () => {
    expect(INDIA_SCOPE_MARKERS).not.toContain("bengali");
    expect(INDIA_SCOPE_MARKERS).not.toContain("bangla");
  });

  it("the other six language markers are untouched", () => {
    for (const m of ["telugu", "tamil", "malayalam", "kannada", "hindi", "marathi"]) {
      expect(INDIA_SCOPE_MARKERS).toContain(m);
    }
  });
});

describe("indiaScope — the Dhaka/Bengali headline no longer wins on an Indian marker", () => {
  it("REGRESSION — 'Dhaka … Bengali cinema' now takes the FOREIGN path", () => {
    // The exact hole: "bengali" sat in the Indian list, which is checked FIRST,
    // so it beat the "dhaka" foreign marker sitting right below it. With
    // "bengali" removed, no Indian marker matches and "dhaka" decides.
    const v = indiaScope("Dhaka premiere caps a strong year for Bengali cinema");
    expect(v.inScope).toBe(false);
    expect(v.reason).toContain("foreign marker");
    expect(v.reason).toContain("dhaka");
  });

  it("a Bengali-only headline with NO foreign marker FAILS OPEN, it is not rejected", () => {
    // Removing the marker must not start silently eating West Bengal stories.
    // With no marker either way, the documented fail-open branch admits it and
    // the editor decides. Nationality proper is the country gate's job.
    const v = indiaScope("Bengali cinema veteran begins a new shoot");
    expect(v.inScope).toBe(true);
    expect(v.reason).toContain("fail-open");
  });

  it("an explicitly Indian Bengali story still admits on its OTHER markers", () => {
    expect(indiaScope("Indian Bengali drama heads to hoichoi").inScope).toBe(true);
    expect(indiaScope("Bengali drama sells Nizam rights for 12 crore").inScope).toBe(true);
  });

  it("the pre-existing Bangladeshi exclusion is unchanged", () => {
    expect(indiaScope("Bangladeshi drama premieres in Dhaka").inScope).toBe(false);
  });
});
