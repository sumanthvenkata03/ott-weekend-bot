// NEWS DESK — caption name sweep (ruling R5). The backing corpus is the
// stories' OWN text: headlines + basis lines + outlet names.
import { describe, it, expect } from "vitest";
import { buildNewsNameAllowlist, sweepCaption } from "../news-sweep.js";
import { sweepNames } from "../../../shared/copy-guard.js";
import type { VerifiedStory } from "../news-verify.js";
import type { ScoredCluster } from "../news-score.js";
import type { NewsItem } from "../news-gather.js";

const item = (title: string): NewsItem => ({
  title, url: "https://news.google.com/x", source: "The Hindu",
  publishedISO: "2026-07-19T06:00:00.000Z", language: "Tamil",
});

const mk = (headline: string, basis: string, outlets = ["The Hindu"]): VerifiedStory => ({
  cluster: {
    id: "c1", headline, language: "Tamil", items: [item(headline)], outlets,
    outletCount: outlets.length, bestTier: "A", hasTierC: false, storyClass: "awards",
    classWeight: 4, suppressed: false, tierPoints: 3, crossOutletPoints: 1,
    judgedTitle: null, judgedPoints: 0, score: 8, eligible: true, holdReason: "",
  } as ScoredCluster,
  confirmed: true,
  sourceUrl: "https://thehindu.com/x",
  basis,
});

describe("news caption sweep — backing corpus is the stories' own text", () => {
  const stories = [
    mk(
      "72nd National Awards: Mammootty and Kartik Aaryan share Best Actor",
      "The Hindu confirms Mammootty and Kartik Aaryan shared the award",
      ["The Hindu", "Cinema Express"]
    ),
  ];

  it("passes a caption naming people the SOURCES printed", () => {
    const hits = sweepCaption(
      "Mammootty and Kartik Aaryan share Best Actor, per The Hindu.",
      stories
    );
    expect(hits).toEqual([]);
  });

  it("FLAGS a person the sources never printed (the fabrication guard)", () => {
    const hits = sweepCaption(
      "Mammootty shares Best Actor with Kartik Aaryan, alongside Rajinikanth.",
      stories
    );
    // Trailing punctuation rides along in the captured run — the shared
    // CAP_WORD allows internal periods for initials ("A.R."), so a
    // sentence-final period is captured too. Legacy behaviour, identical in Wed
    // Drop; the violation is what matters, not its exact trim.
    expect(hits.join(" ")).toContain("Rajinikanth");
  });

  it("does NOT flag a source-truncated first name (the 'Kartik' case)", () => {
    // The outlet itself printed the short form, so it is in the corpus and
    // backs itself. R5: this is a prompt concern, never a guard failure.
    expect(sweepCaption("Confirmed by Kartik Aaryan himself.", stories)).toEqual([]);
  });

  it("DOCUMENTED LIMITATION — a prose corpus cannot catch a cross-blend", () => {
    // Wed Drop backs names against a ROSTER: one token-set per real person, so
    // "Shahid Kapoor" riding a real "Janhvi Kapoor" is caught. News backs against
    // PROSE: a whole headline becomes ONE backing entry, so any two names that
    // appeared in the SAME headline blend freely.
    //
    // This is a real weakening versus the film-data sites, recorded here rather
    // than hidden: the news guard's job is to reject names with NO provenance in
    // the sources, not to adjudicate which tokens belong to which person.
    expect(sweepCaption("A win for Kartik Mammootty at the ceremony.", stories)).toEqual([]);
  });

  it("treats desk furniture and platform names as non-person filler", () => {
    const hits = sweepCaption(
      "TBSI RADAR — every big release, on your radar. Now streaming on Prime Video.",
      stories
    );
    expect(hits).toEqual([]);
  });

  it("counts outlet names as backing text", () => {
    expect(sweepCaption("Confirmed by Cinema Express.", stories)).toEqual([]);
  });
});

describe("buildNewsNameAllowlist", () => {
  it("includes headline, basis and outlets in the backing corpus", () => {
    const allow = buildNewsNameAllowlist([mk("Vetrimaaran begins a new film", "Per Gulte, Vetrimaaran starts", ["Gulte"])]);
    expect(sweepNames("Vetrimaaran begins a new film.", allow)).toEqual([]);
    expect(sweepNames("Ram Charan begins a new film.", allow)).toContain("Ram Charan");
  });

  it("an empty story set backs nothing — every name-shaped run is a violation", () => {
    const allow = buildNewsNameAllowlist([]);
    // A LONE capitalized word is not name-shaped (the sweep needs a 2–3 word
    // run or a join-trigger single) — "Mammootty wins." yields no candidate at
    // all. A two-word name does, and with no corpus it cannot be backed.
    expect(sweepNames("Mammootty wins.", allow)).toEqual([]);
    expect(sweepNames("Kartik Aaryan wins.", allow)).toContain("Kartik Aaryan");
  });
});
