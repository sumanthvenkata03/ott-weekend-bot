// SAT VERDICT — manual exclusion (SAT_VERDICT_EXCLUDE).
//
// Anchors the Issue 038 recompose: three operator-pulled films must never reach
// carding, everything else must be byte-identical to the unfiltered run, and the
// filter must sit BEFORE the billed deep-research slice (that last one is a
// source-level pin, in the wiring-pins.test.ts idiom — it is about WHERE the
// call is made, which the type system cannot express).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseExcludeList, isManuallyExcluded } from "../../shared/exclude-list.js";
import { selectVerdictCards, type VerdictEntry } from "../../content/weekend/verdict-select.js";
import type { Release } from "../../shared/types.js";
import type { VerdictSlide } from "../../delivery/notion.js";
import type { VerdictResearch } from "../../content/weekend/verdict-research.js";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
/** Drop // line comments and block comments so prose can't satisfy a pin. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

// ── The real Issue 038 window ──────────────────────────────────────────────
// Titles, TMDb ids and verdicts are the ACTUAL run
// (data/research-archive/verdicts-2026-08-08.jsonl, runAt 2026-08-08T17:35:49Z);
// tmdbPopularity values are synthetic but strictly ordered, since the selector
// only ever compares them. The four confidence:'none' films from that run are
// omitted: the job filters `research.verdict !== null` before the selector ever
// sees them, so they are not part of this seam.
const ISSUE_038: { title: string; tmdbId: number; verdict: VerdictSlide["verdict"]; pop: number }[] = [
  { title: "G.D.N",                      tmdbId: 1489543, verdict: "🔥 Must Watch",    pop: 90 },
  { title: "DC",                         tmdbId: 1479832, verdict: "👀 Worth a Try",   pop: 80 },
  { title: "Aryabhatt Ka Zero",          tmdbId: 1714993, verdict: "👀 Worth a Try",   pop: 70 },
  { title: "Ohh My Dog",                 tmdbId: 1727563, verdict: "👀 Worth a Try",   pop: 60 },
  { title: "The Great Punjab Robbery",   tmdbId: 1657464, verdict: "👀 Worth a Try",   pop: 50 },
  { title: "Thudakkam",                  tmdbId: 1506736, verdict: "👀 Worth a Try",   pop: 40 },
  { title: "Korean Kanakaraju",          tmdbId: 1423253, verdict: "👀 Worth a Try",   pop: 30 },
  { title: "Yaar Jigree Kasooti Degree", tmdbId: 1735283, verdict: "👀 Worth a Try",   pop: 25 },
  { title: "Photographer",               tmdbId: 1740942, verdict: "👀 Worth a Try",   pop: 20 },
  { title: "Rehmat",                     tmdbId: 1649061, verdict: "👀 Worth a Try",   pop: 15 },
  { title: "Ayogya 2",                   tmdbId: 1396778, verdict: "🎟️ One-Time Watch", pop: 10 },
  { title: "KJQ",                        tmdbId: 1437143, verdict: "⏭️ Skip",           pop: 5 },
];

/** The operator's Issue 038 ruling, as it would be typed into the env var. */
const SAT_038_EXCLUDE = "1649061,1396778,1735283";
const EXCLUDED_IDS = [1649061, 1396778, 1735283];

function release(f: (typeof ISSUE_038)[number]): Release {
  return { title: f.title, tmdbId: f.tmdbId, tmdbPopularity: f.pop } as unknown as Release;
}

/** Minimal VerdictEntry fake — only the fields the selector reads. */
function entry(f: (typeof ISSUE_038)[number]): VerdictEntry {
  const slide = { filmTitle: f.title, verdict: f.verdict } as unknown as VerdictSlide;
  return { slide, release: release(f), research: {} as VerdictResearch };
}

const titles = (es: VerdictEntry[]) => es.map(e => e.slide.filmTitle);

/** The job's real shape: ingest → manual exclude → (sort/cap) → research → select. */
function runSelection(raw: string | undefined) {
  const ex = parseExcludeList(raw);
  const included = ISSUE_038.filter(f => !isManuallyExcluded(release(f), ex));
  return { included, ...selectVerdictCards(included.map(entry)) };
}

describe("(i) an excluded TMDb id never reaches carding", () => {
  const { selected, trimmedSkips } = runSelection(SAT_038_EXCLUDE);
  const carded = titles(selected);

  it("none of the three pulled films is carded", () => {
    expect(carded).not.toContain("Rehmat");
    expect(carded).not.toContain("Ayogya 2");
    expect(carded).not.toContain("Yaar Jigree Kasooti Degree");
  });

  it("nor do they reach the ALSO SKIPPING footer (excluded ≠ trimmed)", () => {
    expect(titles(trimmedSkips)).toEqual([]);
  });

  it("the eight operator-named films are all carded", () => {
    for (const t of [
      "DC", "Aryabhatt Ka Zero", "Ohh My Dog", "The Great Punjab Robbery",
      "Thudakkam", "G.D.N", "Korean Kanakaraju", "Photographer",
    ]) {
      expect(carded, t).toContain(t);
    }
  });

  // GOAL-STATE DIVERGENCE — deliberately pinned, not papered over.
  // The brief asked for exactly 8. Exclusion alone yields NINE: with 11 non-Skip
  // films the ceiling was saturated (skipSlots = max(0, 10-11) = 0) and KJQ was
  // trimmed to ALSO SKIPPING. Removing three non-Skip films frees two Skip slots
  // (skipSlots = max(0, 10-8) = 2), so KJQ now cards on its own merits. That is
  // the selector working as designed — see verdict-select.ts:87-88. Getting to 8
  // needs either KJQ in the exclude list too (tmdb 1437143) or a selector change,
  // and D4 said no selector changes.
  it("selection is NINE cards — the named 8 plus KJQ, which the freed Skip slot re-admits", () => {
    expect(carded).toHaveLength(9);
    expect(carded).toContain("KJQ");
    expect(carded[carded.length - 1]).toBe("KJQ"); // Skip tier sorts last
  });
});

describe("(ii) non-excluded films are untouched", () => {
  it("ordering and membership of the survivors match the unfiltered run exactly", () => {
    const before = titles(runSelection(undefined).selected).filter(t => !["Rehmat", "Ayogya 2", "Yaar Jigree Kasooti Degree"].includes(t));
    const after = titles(runSelection(SAT_038_EXCLUDE).selected);
    // Same films, same relative order — the only delta is KJQ's re-admission,
    // which the unfiltered run had trimmed rather than dropped.
    expect(after.filter(t => t !== "KJQ")).toEqual(before);
  });

  it("tier assignment is unchanged for every survivor", () => {
    const { selected } = runSelection(SAT_038_EXCLUDE);
    const byTitle = new Map(ISSUE_038.map(f => [f.title, f.verdict]));
    for (const e of selected) {
      expect(e.slide.verdict, e.slide.filmTitle).toBe(byTitle.get(e.slide.filmTitle));
    }
  });

  it("an id that is not in the window is inert", () => {
    expect(titles(runSelection("999999").selected)).toEqual(titles(runSelection(undefined).selected));
  });
});

describe("(iii) an empty list is exactly current behaviour", () => {
  const baseline = titles(runSelection(undefined).selected);

  it.each([undefined, "", "   ", ",", " , , "])("raw %o → identity", (raw) => {
    expect(titles(runSelection(raw as string | undefined).selected)).toEqual(baseline);
  });

  it("the unfiltered run is the 11 cards Issue 038 actually shipped, KJQ trimmed", () => {
    expect(baseline).toHaveLength(11);
    expect(baseline).not.toContain("KJQ");
    expect(titles(runSelection(undefined).trimmedSkips)).toEqual(["KJQ"]);
  });
});

describe("(iv) match by TMDb id, never by title", () => {
  const ex = parseExcludeList(SAT_038_EXCLUDE);

  it("an id token does not match a same-named film carrying a different id", () => {
    const impostor = { title: "Rehmat", tmdbId: 424242 } as unknown as Release;
    expect(isManuallyExcluded(impostor, ex)).toBe(false);
  });

  it("an id token still matches when the title has been rewritten upstream", () => {
    const renamed = { title: "Rehmat (2026)", tmdbId: 1649061 } as unknown as Release;
    expect(isManuallyExcluded(renamed, ex)).toBe(true);
  });

  it("a title token does not match a film by id", () => {
    const byTitle = parseExcludeList("Rehmat");
    expect(byTitle.ids.size).toBe(0);
    expect(isManuallyExcluded({ title: "Rehmat", tmdbId: 1649061 } as unknown as Release, byTitle)).toBe(true);
    expect(isManuallyExcluded({ title: "Other", tmdbId: 1649061 } as unknown as Release, byTitle)).toBe(false);
  });

  it("title matching stays case- and whitespace-insensitive, id parsing stays strict", () => {
    const mixed = parseExcludeList(" REHMAT , 1396778 , 12.5 , 1e3 ");
    expect([...mixed.ids]).toEqual([1396778]);          // only the exact integer
    expect(mixed.titles).toContain("12.5");             // non-integer → title token
    expect(mixed.titles).toContain("1e3");              // String(1000) !== "1e3"
    expect(isManuallyExcluded({ title: "  Rehmat  " } as unknown as Release, mixed)).toBe(true);
  });

  it("a film with no tmdbId is matched by title only, never by an id token", () => {
    expect(isManuallyExcluded({ title: "Rehmat" } as unknown as Release, ex)).toBe(false);
  });
});

describe("(v) placement pin — the exclude runs before the billed research slice", () => {
  const src = code(read("src/jobs/saturday-verdict.ts"));

  it("saturday-verdict.ts reads SAT_VERDICT_EXCLUDE, not Wednesday's var", () => {
    expect(src).toContain("process.env.SAT_VERDICT_EXCLUDE");
    expect(src).not.toContain("WED_DROP_EXCLUDE");
  });

  it("the filter sits between ingestReleases and the popularity sort", () => {
    const ingest = src.indexOf("await ingestReleases(");
    const filter = src.indexOf("isManuallyExcluded(r, manualExcluded)");
    const sort = src.indexOf("const pool = [...");
    expect(ingest).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(ingest);
    expect(filter).toBeLessThan(sort);
  });

  it("it precedes BOTH spend seams — deep research and the cover LLM call", () => {
    // Compare against USE sites, not declarations: MAX_RESEARCH_FILMS and
    // researchFilmCached are both declared near the top of the file, so a bare
    // indexOf on the identifier would find the declaration and pass vacuously.
    const filter = src.indexOf("isManuallyExcluded(r, manualExcluded)");
    const researchSlice = src.indexOf("pool.slice(0, MAX_RESEARCH_FILMS)");
    const researchCall = src.indexOf("researchFilmCached(film))");
    const coverCall = src.indexOf("await generateVerdictCover(");
    expect(researchSlice, "research slice use-site").toBeGreaterThan(-1);
    expect(researchCall, "research call use-site").toBeGreaterThan(-1);
    expect(coverCall, "cover LLM use-site").toBeGreaterThan(-1);
    expect(filter).toBeLessThan(researchSlice);
    expect(filter).toBeLessThan(researchCall);
    expect(filter).toBeLessThan(coverCall);
  });

  it("the research pool is built from the filtered list, never the raw ingest", () => {
    // `pool` must derive from `included`; if it ever reverts to `releases` the
    // excluded films silently get researched (and billed) again.
    expect(src).toContain("const pool = [...included]");
    expect(src).not.toContain("const pool = [...releases]");
  });

  it("the excluded films are logged with title AND tmdb id", () => {
    expect(src).toContain("Manual exclude (SAT_VERDICT_EXCLUDE)");
    expect(src).toContain("tmdb-${r.tmdbId");
  });
});

describe("shared extraction — Wednesday is a pure move, zero behaviour change", () => {
  it("wednesday-drop.ts imports the helpers instead of declaring them", () => {
    const src = code(read("src/jobs/wednesday-drop.ts"));
    expect(src).toContain('from "../shared/exclude-list.js"');
    expect(src).not.toContain("function parseExcludeList(");
    expect(src).not.toContain("function isManuallyExcluded(");
  });

  it("Wednesday still applies its own env var at its own (post-gate) seam", () => {
    const src = code(read("src/jobs/wednesday-drop.ts"));
    expect(src).toContain("parseExcludeList(process.env.WED_DROP_EXCLUDE)");
    expect(src).toContain("parseExcludeList(process.env.WED_DROP_FORCE)");
  });

  it("both pillars share one parser — the grammar cannot drift", () => {
    const shared = code(read("src/shared/exclude-list.ts"));
    expect(shared).toContain("export function parseExcludeList");
    expect(shared).toContain("export function isManuallyExcluded");
    for (const id of EXCLUDED_IDS) {
      expect(parseExcludeList(SAT_038_EXCLUDE).ids.has(id), String(id)).toBe(true);
    }
  });
});
