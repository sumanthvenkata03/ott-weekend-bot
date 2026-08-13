// WD-042 Part 3 — THE LLM NEVER SEES WHAT IT MAY NOT PRINT.
//
// buildStampContext already refuses a TBSI seal to a film with no real vote base
// (WD-041-FIX-A), so those cards render NEW. But the copy model was still handed
// the number, and a model handed "IMDb 8.3" writes about 8.3 — the seal says NEW
// while the blurb says 8.3. Prompt instructions are not a control surface;
// absence is. These pin that the number never reaches the payload at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop, stripScoresForPrompt } from "./wednesday-drop.js";
import { hasRealVoteBase } from "../../shared/post-validator.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mkRelease(p: Partial<Release> & { title: string }): Release {
  return {
    id: `tmdb-${p.title}`, language: "Malayalam", isSeries: false,
    platform: ["ManoramaMAX"] as Release["platform"], releaseDate: "2026-08-13",
    genre: ["Action"], cast: ["Antony Varghese"], synopsis: "A film.",
    subtitleLanguages: [], sources: ["tmdb"], fetchedAt: "2026-08-13T00:00:00.000Z",
    ...p,
  } as Release;
}

/** Kattalan as WD-042 carried it: a real tbsiScore, no audience behind it. */
const KATTALAN = mkRelease({
  title: "Kattalan",
  tbsiScore: 8.3,
  tbsiSourceCount: 1,
  imdbRating: 8.3,
  tmdbVoteAverage: 8.3,
  tmdbVoteCount: 4,
  leadCast: ["Antony Varghese", "Sunil Varma"],
  musicDirector: "Ravi Basrur",
});

/** Aakhri Sawal with a real vote base — scores must survive. */
const AAKHRI = mkRelease({
  title: "Aakhri Sawal",
  language: "Hindi",
  tbsiScore: 6.3,
  imdbRating: 6.3,
  imdbVotes: 1240,
  tmdbVoteCount: 96,
  tmdbVoteAverage: 6.4,
  leadCast: ["Sanjay Dutt", "Namashi Chakraborty"],
});

/** A NEW-stamp film: no score at all, no votes. */
const SARVAGUNN = mkRelease({ title: "Sarvagunn Sampann", language: "Hindi", tmdbVoteAverage: 0, tmdbVoteCount: 0 });

function llmOut(releaseSlides: Array<{ title: string; body: string }>) {
  return {
    caption: "A stacked week.",
    hashtags: ["#NowStreaming"],
    namesUsed: [],
    carouselSlides: [
      { slideNumber: 1, type: "cover", title: "Cover", body: "sub", isMusicDirectorNotable: false },
      { slideNumber: 2, type: "index", title: "This weekend", body: "list", isMusicDirectorNotable: false },
      ...releaseSlides.map((r, i) => ({ slideNumber: i + 3, type: "release", title: r.title, body: r.body, isMusicDirectorNotable: false })),
      { slideNumber: releaseSlides.length + 3, type: "cta", title: "CTA", body: "which?", isMusicDirectorNotable: false },
    ],
  };
}

/** The prompt string actually handed to the model on call N (0-indexed). */
const promptOf = (n = 0) => String(mockCall.mock.calls[n]![0]);

beforeEach(() => mockCall.mockReset());

describe("stripScoresForPrompt — keyed to hasRealVoteBase", () => {
  it("strips EVERY score field from a film with no vote base", () => {
    expect(hasRealVoteBase(KATTALAN)).toBe(false);
    const s = stripScoresForPrompt(KATTALAN);
    for (const f of ["tbsiScore", "tbsiSourceCount", "imdbRating", "rottenTomatoes",
                     "rtAudience", "metacritic", "letterboxd", "tmdbVoteAverage",
                     "tmdbVoteCount", "imdbVotes"]) {
      expect(s, f).not.toHaveProperty(f);
    }
    expect(JSON.stringify(s)).not.toContain("8.3");
  });

  it("keeps non-score fields intact", () => {
    const s = stripScoresForPrompt(KATTALAN);
    expect(s.title).toBe("Kattalan");
    expect(s.musicDirector).toBe("Ravi Basrur");
    expect(s.leadCast).toEqual(["Antony Varghese", "Sunil Varma"]);
    expect(s.platform).toEqual(["ManoramaMAX"]);
  });

  it("leaves a vote-backed film completely untouched — same object", () => {
    expect(hasRealVoteBase(AAKHRI)).toBe(true);
    expect(stripScoresForPrompt(AAKHRI)).toBe(AAKHRI);
  });

  it("a film with no scores at all is inert", () => {
    expect(stripScoresForPrompt(SARVAGUNN).title).toBe("Sarvagunn Sampann");
  });

  it("50 TMDb votes qualifies, 49 does not — the boundary is the shared predicate", () => {
    const at = mkRelease({ title: "At", tbsiScore: 7.7, tmdbVoteCount: 50 });
    const below = mkRelease({ title: "Below", tbsiScore: 7.7, tmdbVoteCount: 49 });
    expect(stripScoresForPrompt(at)).toHaveProperty("tbsiScore");
    expect(stripScoresForPrompt(below)).not.toHaveProperty("tbsiScore");
  });
});

describe("the serialized LLM payload", () => {
  it("KATTALAN: contains no \"8.3\" and no score keys", async () => {
    mockCall.mockResolvedValue(llmOut([{ title: "Kattalan", body: "Antony Varghese leads." }]));
    await generateWednesdayDrop([KATTALAN], "ott", "2026-08-10", "2026-08-16");

    const prompt = promptOf(0);
    expect(prompt).toContain("Kattalan");                 // the film IS in the payload
    expect(prompt).not.toContain("8.3");                  // its number is not
    expect(prompt).not.toContain("tbsiScore");
    expect(prompt).toContain("IMDb: not yet rated");      // the honest rendering
  });

  it("AAKHRI SAWAL: a real vote base keeps its score in the payload", async () => {
    mockCall.mockResolvedValue(llmOut([{ title: "Aakhri Sawal", body: "Sanjay Dutt anchors it." }]));
    await generateWednesdayDrop([AAKHRI], "ott", "2026-08-10", "2026-08-16");

    const prompt = promptOf(0);
    expect(prompt).toContain("6.3");
    expect(prompt).toContain("1240 votes");
  });

  it("MIXED EDITION: the unbacked film's number is gone, the backed one's survives", async () => {
    mockCall.mockResolvedValue(
      llmOut([
        { title: "Kattalan", body: "Antony Varghese leads." },
        { title: "Aakhri Sawal", body: "Sanjay Dutt anchors it." },
      ])
    );
    await generateWednesdayDrop([KATTALAN, AAKHRI], "ott", "2026-08-10", "2026-08-16");

    const prompt = promptOf(0);
    expect(prompt).not.toContain("8.3");
    expect(prompt).toContain("6.3");
  });

  it("NEW-stamp films' payloads are score-free", async () => {
    mockCall.mockResolvedValue(llmOut([{ title: "Sarvagunn Sampann", body: "A family drama." }]));
    await generateWednesdayDrop([SARVAGUNN], "ott", "2026-08-10", "2026-08-16");

    const prompt = promptOf(0);
    expect(prompt).toContain("Sarvagunn Sampann");
    expect(prompt).toContain("IMDb: not yet rated");
    for (const key of ["tbsiScore", "Rotten", "Metacritic", "Letterboxd"]) {
      expect(prompt).not.toContain(key);
    }
  });

  it("the RETRY prompt is score-stripped too — a second pass cannot leak it", async () => {
    // An unbacked name forces the retry; the rebuilt prompt must still be clean.
    // "and Tabu lead" is the join-trigger shape the sweep captures as a lone name.
    mockCall.mockResolvedValue(
      llmOut([{ title: "Kattalan", body: "Antony Varghese and Tabu lead the film." }])
    );
    await generateWednesdayDrop([KATTALAN], "ott", "2026-08-10", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(promptOf(1)).not.toContain("8.3");
  });
});

describe("stripping is prompt-only — the cards keep their data", () => {
  it("the returned draft's releases still carry the score the seal logic reads", async () => {
    mockCall.mockResolvedValue(llmOut([{ title: "Kattalan", body: "Antony Varghese leads." }]));
    const draft = await generateWednesdayDrop([KATTALAN], "ott", "2026-08-10", "2026-08-16");

    const carded = draft.releases.find((r) => r.title === "Kattalan")!;
    expect(carded.tbsiScore).toBe(8.3);   // untouched — buildStampContext still decides
    expect(KATTALAN.tbsiScore).toBe(8.3); // and the input was never mutated
  });
});
