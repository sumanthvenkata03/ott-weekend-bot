// WD-ENG-01 PARTS 1 & 3, end-to-end through the real generator.
//
// THE RULING: a film in the pool the gate approved and fed to the LLM cannot be
// removed by the copy guard. Issue 041 deleted Batwara 1947 over a possessive;
// Issue 042 deleted Aroopi over "Lights-off Malayalam". In both cases a green,
// reconciled, verified, platform-resolved film left the deck because of a PHRASE
// — and in both cases the phrase was never a person's name.
//
// The guard keeps its authority over COPY and loses its authority over FILMS.
// The drop path survives for exactly one case: a slide whose title no Release
// record backs, which is a hallucinated film rather than a hallucinated word.
//
// Fixtures are the real Aug-13 OTT edition: name fields, caption and index body
// verbatim from output/runs/wed-drop-ott-2026-08-13-*.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop, safeBlurb } from "./wednesday-drop.js";
import { buildAllowlist, sweepNames } from "../../shared/copy-guard.js";
import { WED_DROP_NON_PERSON_WORDS } from "./wednesday-drop.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mk(p: Partial<Release> & { title: string }): Release {
  return {
    id: `tmdb-${p.title}`, language: "Hindi", isSeries: false,
    platform: ["ZEE5"] as Release["platform"], releaseDate: "2026-08-14",
    genre: ["Drama"], cast: [], synopsis: "A film.", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-13T00:00:00.000Z",
    ...p,
  } as Release;
}

// ── The real Aug-13 OTT edition ─────────────────────────────────────────────
const AROOPI = mk({
  title: "Aroopi", language: "Malayalam", platform: ["Prime Video"] as Release["platform"],
  genre: ["Horror", "Thriller"], leadCast: ["Neha Chawla", "Vysakh Ravi"], musicDirector: "Gopi Sundar",
});
const KATTALAN = mk({
  title: "Kattalan", language: "Malayalam", platform: ["ManoramaMAX"] as Release["platform"],
  genre: ["Action"], leadCast: ["Antony Varghese"], musicDirector: "Ravi Basrur",
});
const AAKHRI = mk({
  title: "Aakhri Sawal", platform: ["Lionsgate Play"] as Release["platform"],
  genre: ["Drama"], leadCast: ["Sanjay Dutt"],
});
const COCKTAIL_2 = mk({
  title: "Cocktail 2", platform: ["Netflix"] as Release["platform"], genre: ["Romance"],
  leadCast: ["Kriti Sanon", "Shahid Kapoor"], director: "Homi Adajania", musicDirector: "Pritam Chakraborty",
});
const HEARTIN = mk({
  title: "Heartin", language: "Tamil", platform: ["Prime Video"] as Release["platform"],
  genre: ["Romance"], leadCast: ["Madonna Sebastian", "Sananth"], musicDirector: "Rajesh Murugesan",
});
const BHARAT = mk({ title: "Bharat Bhhagya Viddhaata", genre: ["Drama"], leadCast: ["Kangana Ranaut"] });
const SARVAGUNN = mk({ title: "Sarvagunn Sampann", genre: ["Drama"], leadCast: ["Vaani Kapoor", "Ishwak Singh"] });

/** The seven films actually fed to the LLM on Aug 13. */
const FED_SEVEN = [AAKHRI, COCKTAIL_2, BHARAT, KATTALAN, AROOPI, HEARTIN, SARVAGUNN];

const REAL_CAPTION =
  "Sanjay Dutt walks into a televised 'intellectual trial' and the whole country's watching — " +
  "Aakhri Sawal is the week's only rated drop (6.3) and the one to start with, on Lionsgate Play. " +
  "Over on Netflix, Homi Adajania reboots the rom-com with Cocktail 2. Kangana Ranaut holds a hospital " +
  "together through the 26/11 chaos in Bharat Bhhagya Viddhaata. Kattalan brings Malayalam ivory-cartel " +
  "carnage. Aroopi unleashes a proper Yakshini scare. Tamil's Heartin is your easy rom-com night. " +
  "Seven drops, every platform sorted. Save this for the weekend.";

const REAL_INDEX = [
  "Aakhri Sawal (Hindi) → Lionsgate Play",
  "Cocktail 2 (Hindi) → Netflix",
  "Bharat Bhhagya Viddhaata (Hindi) → ZEE5",
  "Kattalan (Malayalam) → ManoramaMAX",
  "Aroopi (Malayalam) → Prime Video",
  "Heartin (Tamil) → Prime Video",
  "Sarvagunn Sampann (Hindi) → ZEE5",
].join("\n");

function llmOut(
  releaseSlides: Array<{ title: string; body: string }>,
  opts: { caption?: string; index?: string; namesUsed?: string[] } = {}
) {
  return {
    caption: opts.caption ?? REAL_CAPTION,
    hashtags: ["#NowStreaming"],
    namesUsed: opts.namesUsed ?? [],
    carouselSlides: [
      { slideNumber: 1, type: "cover", title: "Cover", body: "sub", isMusicDirectorNotable: false },
      { slideNumber: 2, type: "index", title: "This weekend", body: opts.index ?? REAL_INDEX, isMusicDirectorNotable: false },
      ...releaseSlides.map((r, i) => ({
        slideNumber: i + 3, type: "release", title: r.title, body: r.body, isMusicDirectorNotable: false,
      })),
      { slideNumber: releaseSlides.length + 3, type: "cta", title: "CTA", body: "which one?", isMusicDirectorNotable: false },
    ],
  };
}

/** All seven slides, with one body swapped — the real Aug-13 deck shape. */
function sevenSlides(override: { title: string; body: string }) {
  return FED_SEVEN.map((r) =>
    r.title === override.title ? override : { title: r.title, body: `A solid ${r.language} pick.` }
  );
}

const bodyOf = (draft: { slides: Array<{ type: string; title: string; body: string }> }, title: string) =>
  draft.slides.find((s) => s.type === "release" && s.title === title)!.body;

beforeEach(() => mockCall.mockReset());

// ════════════════════════════════════════════════════════════════════════════
describe("PART 2 IN SITU — Aroopi's real slide text is clean, so nothing changes at all", () => {
  it("the exact phrase that dropped the film → no violation, no retry, ORIGINAL blurb, film ships", async () => {
    const REAL_BLURB = "Lights-off Malayalam horror done right.";
    mockCall.mockResolvedValue(llmOut(sevenSlides({ title: "Aroopi", body: REAL_BLURB })));

    const draft = await generateWednesdayDrop(FED_SEVEN, "ott", "2026-08-10", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(1);            // NO retry
    expect(draft.nameFlags).toEqual([]);                  // NO flags
    expect(draft.copyNotices).toEqual([]);                // NO notices
    expect(draft.releases).toHaveLength(7);               // ALL SEVEN ship
    expect(draft.releases.map((r) => r.title)).toContain("Aroopi");
    // …and it keeps its own copy — no fallback was needed.
    expect(bodyOf(draft, "Aroopi")).toBe(REAL_BLURB);
    // The caption is untouched: no drop happened, so no scrub ran.
    expect(draft.caption).toBe(REAL_CAPTION);
    expect(draft.caption).toContain("Seven drops");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 1 ALONE — proven with a phrase Part 2 does NOT catch", () => {
  // "Slow Burn Malayalam" has no hyphen, so severHyphenLowercase never sees it
  // and the sweep flags it exactly as it flagged "Lights-off Malayalam" before.
  // That isolates Part 1: the film survives because it was FED, not because the
  // extraction got smarter.
  const SYNTHETIC = "Slow Burn Malayalam horror done right.";

  it("PRECONDITION: the synthetic phrase really is an unbacked violation", () => {
    const allow = buildAllowlist({
      personNames: FED_SEVEN.flatMap((r) => [...(r.leadCast ?? []), r.director, r.musicDirector]),
      nonPersonText: FED_SEVEN.flatMap((r) => [r.title, ...r.platform, r.language]),
      nonPersonWords: WED_DROP_NON_PERSON_WORDS,
    });
    expect(sweepNames(SYNTHETIC, allow)).toEqual(["Slow Burn Malayalam"]);
  });

  it("2 strikes on a FED film → blurb replaced, film SHIPS, deck intact", async () => {
    mockCall.mockResolvedValue(llmOut(sevenSlides({ title: "Aroopi", body: SYNTHETIC })));

    const draft = await generateWednesdayDrop(FED_SEVEN, "ott", "2026-08-10", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(2);                    // retry fired and failed
    // THE RULING: seven fed, seven shipped.
    expect(draft.releases).toHaveLength(7);
    expect(draft.releases.map((r) => r.title)).toContain("Aroopi");

    // The offending phrase never prints.
    expect(bodyOf(draft, "Aroopi")).toBe(safeBlurb(AROOPI, "ott"));
    expect(bodyOf(draft, "Aroopi")).toBe("A new Malayalam horror streaming on Prime Video this week.");
    expect(draft.carouselSlides).not.toContain("Slow Burn");
    expect(draft.caption).not.toContain("Slow Burn");

    // Every OTHER film keeps its own copy — the fallback is surgical.
    for (const r of FED_SEVEN.filter((f) => f.title !== "Aroopi")) {
      expect(bodyOf(draft, r.title), r.title).toBe(`A solid ${r.language} pick.`);
    }

    // No drop happened, so no scrub ran and the count is untouched and correct.
    expect(draft.caption).toContain("Seven drops");
    expect(draft.caption).toContain("Aroopi");
  });

  it("the flag and the notice both say fallback, and name the exact term", async () => {
    mockCall.mockResolvedValue(llmOut(sevenSlides({ title: "Aroopi", body: SYNTHETIC })));
    const draft = await generateWednesdayDrop(FED_SEVEN, "ott", "2026-08-10", "2026-08-16");

    expect(draft.nameFlags).toHaveLength(1);
    expect(draft.nameFlags[0]).toContain("copy-fallback");
    expect(draft.nameFlags[0]).toContain("Aroopi");
    expect(draft.nameFlags[0]).toContain("Slow Burn Malayalam");
    expect(draft.nameFlags[0]).toContain("film SHIPS");
    expect(draft.nameFlags[0]).not.toContain("DROPPED");
    expect(draft.copyNotices).toEqual([
      { kind: "copy-fallback", title: "Aroopi", term: "Slow Burn Malayalam" },
    ]);
  });

  it("THE FALLBACK IS ITSELF SWEEP-CLEAN — it can never trigger a second strike", () => {
    const allow = buildAllowlist({
      personNames: FED_SEVEN.flatMap((r) => [...(r.leadCast ?? []), r.director, r.musicDirector]),
      nonPersonText: FED_SEVEN.flatMap((r) => [r.title, ...r.platform, r.language]),
      nonPersonWords: WED_DROP_NON_PERSON_WORDS,
    });
    for (const r of FED_SEVEN) {
      for (const ed of ["ott", "theatrical"] as const) {
        expect(sweepNames(safeBlurb(r, ed), allow), `${r.title}/${ed}`).toEqual([]);
      }
    }
  });

  it("a superlative claim on a fed film also falls back rather than dropping it", async () => {
    const scored = FED_SEVEN.map((r) =>
      r.title === "Aakhri Sawal" ? { ...r, tbsiScore: 6.3 } : { ...r, tbsiScore: 5 }
    );
    mockCall.mockResolvedValue(
      llmOut(sevenSlides({ title: "Kattalan", body: "The top-rated pick of the week." }))
    );

    const draft = await generateWednesdayDrop(scored, "ott", "2026-08-10", "2026-08-16");

    expect(draft.releases).toHaveLength(7);
    expect(bodyOf(draft, "Kattalan")).toBe(safeBlurb(KATTALAN, "ott"));
    expect(draft.carouselSlides).not.toContain("top-rated");
    expect(draft.copyNotices[0]!.kind).toBe("copy-fallback");
    expect(draft.copyNotices[0]!.title).toBe("Kattalan");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("PART 3 — an UNFED title still drops, and the drop is loud and clean", () => {
  // The pool is the real six minus Aroopi. The model still writes an Aroopi
  // slide, still names it in the caption, still lists it in the index, and still
  // says "Seven drops" — the Issue 042 shape exactly, with the one difference
  // that no Release record backs the title.
  const SIX = FED_SEVEN.filter((r) => r.title !== "Aroopi");

  const run = () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          ...SIX.map((r) => ({ title: r.title, body: `A solid ${r.language} pick.` })),
          { title: "Aroopi", body: "Pritam scores it, and Tabu steals every scene." },
        ]
      )
    );
    return generateWednesdayDrop(SIX, "ott", "2026-08-10", "2026-08-16");
  };

  it("the unfed slide is dropped and the six fed films are untouched", async () => {
    const draft = await run();
    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(draft.releases.map((r) => r.title).sort()).toEqual(
      ["Aakhri Sawal", "Bharat Bhhagya Viddhaata", "Cocktail 2", "Heartin", "Kattalan", "Sarvagunn Sampann"]
    );
    expect(draft.slides.some((s) => s.type === "release" && s.title === "Aroopi")).toBe(false);
  });

  it("NO SURFACE references the removed title — caption, index, or markdown", async () => {
    const draft = await run();
    expect(draft.caption).not.toContain("Aroopi");
    const index = draft.slides.find((s) => s.type === "index")!;
    expect(index.body).not.toContain("Aroopi");
    expect(draft.carouselSlides).not.toContain("Aroopi");
  });

  it("THE COUNT MATCHES THE RENDERED CARDS", async () => {
    const draft = await run();
    const cards = draft.slides.filter((s) => s.type === "release").length;
    expect(cards).toBe(6);
    expect(draft.releases).toHaveLength(cards);           // one card per film
    expect(draft.caption).not.toContain("Seven drops");
    expect(draft.caption).toContain("Six drops");
    // The index lists exactly the rendered films, no more and no fewer.
    const index = draft.slides.find((s) => s.type === "index")!;
    expect(index.body.split("\n")).toHaveLength(cards);
  });

  it("the notice is a copy-drop and the scrub is certified", async () => {
    const draft = await run();
    expect(draft.copyNotices).toEqual([
      { kind: "copy-drop", title: "Aroopi", term: "Tabu" },
    ]);
    expect(draft.copyNotices[0]!.scrubFailed).toBeUndefined();   // clean scrub
    expect(draft.nameFlags[0]).toContain("copy-drop");
  });

  it("an UNCERTIFIABLE scrub marks the notice scrubFailed — the job then blocks", async () => {
    // A caption that is nothing BUT the dropped film cannot be scrubbed into a
    // consistent one, so the guard refuses to certify rather than guessing.
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Kattalan", body: "A solid Malayalam pick." },
          { title: "Aroopi", body: "Pritam scores it, and Tabu steals every scene." },
        ],
        { caption: "Aroopi is the only reason to stream this week", index: "Aroopi (Malayalam) → Prime Video" }
      )
    );

    const draft = await generateWednesdayDrop([KATTALAN], "ott", "2026-08-10", "2026-08-16");

    expect(draft.releases.map((r) => r.title)).toEqual(["Kattalan"]);
    expect(draft.copyNotices).toEqual([
      { kind: "copy-drop", title: "Aroopi", term: "Tabu", scrubFailed: true },
    ]);
  });
});
