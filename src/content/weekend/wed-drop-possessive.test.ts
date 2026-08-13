// WED DROP — the Issue 041 possessive regression, end to end through the
// two-strike machinery (LLM mocked, so this is offline + deterministic).
//
// On 12 Aug 2026 the theatrical edition approved 7 films and rendered 6.
// "Batwara 1947" — tier green, ai-net confirmed, Rajkumar Santoshi directing,
// A.R. Rahman scoring — was dropped by the copy guard on one flag:
//   copy name-discipline: "Rajkumar Santoshi's Partition" not in film data
//     — DROPPED film "Batwara 1947"
// The director was IN the film data the whole time. The sweep fused him to the
// noun he owned. These prove the film now survives, and that the drop machinery
// itself is untouched — a genuinely unbacked name still costs a film its slide.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop } from "./wednesday-drop.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mkRelease(p: {
  title: string; cast?: string[]; director?: string; leadCast?: string[];
  musicDirector?: string;
}): Release {
  return {
    id: `tmdb-${p.title}`, title: p.title, language: "Hindi", isSeries: false,
    platform: [], releaseDate: "2026-08-14",
    genre: ["Drama"], cast: p.cast ?? [], synopsis: "A film.", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-12T00:00:00.000Z",
    ...(p.director ? { director: p.director } : {}),
    ...(p.leadCast ? { leadCast: p.leadCast } : {}),
    ...(p.musicDirector ? { musicDirector: p.musicDirector } : {}),
  };
}

/** Issue 041's real record for tmdb-1169537. */
const BATWARA = mkRelease({
  title: "Batwara 1947",
  cast: ["Aamir Khan", "Preity G Zinta", "Sunny Deol"],
  leadCast: ["Sunny Deol", "Preity Zinta"],
  director: "Rajkumar Santoshi",
  musicDirector: "A.R. Rahman",
});
const AWARAPAN = mkRelease({ title: "Awarapan 2", cast: ["Emraan Hashmi"], leadCast: ["Emraan Hashmi"] });

function llmOut(
  releaseSlides: Array<{ title: string; body: string }>,
  opts: { caption?: string; namesUsed?: string[] } = {}
) {
  return {
    caption: opts.caption ?? "A stacked weekend in cinemas.",
    hashtags: ["#InTheaters", "#Bollywood"],
    namesUsed: opts.namesUsed ?? [],
    carouselSlides: [
      { slideNumber: 1, type: "cover", title: "Cover", body: "sub", isMusicDirectorNotable: false },
      { slideNumber: 2, type: "index", title: "This weekend", body: "list", isMusicDirectorNotable: false },
      ...releaseSlides.map((r, i) => ({ slideNumber: i + 3, type: "release", title: r.title, body: r.body, isMusicDirectorNotable: false })),
      { slideNumber: releaseSlides.length + 3, type: "cta", title: "CTA", body: "which one?", isMusicDirectorNotable: false },
    ],
  };
}

beforeEach(() => mockCall.mockReset());

describe("Issue 041 — the possessive no longer costs an approved film its slide", () => {
  it("REGRESSION: \"Rajkumar Santoshi's Partition\" passes on the FIRST call — no retry, no flag, film kept", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Batwara 1947", body: "Rajkumar Santoshi's Partition epic, with Sunny Deol and Aamir Khan." },
          { title: "Awarapan 2", body: "Emraan Hashmi returns." },
        ],
        { namesUsed: ["Rajkumar Santoshi", "Sunny Deol", "Aamir Khan", "Emraan Hashmi"] }
      )
    );

    const draft = await generateWednesdayDrop([BATWARA, AWARAPAN], "theatrical", "2026-08-12", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(1);              // no retry fired at all
    expect(draft.nameFlags).toEqual([]);
    // Membership, not order — draft.releases is ordered downstream for
    // presentation and that ordering is not what this regression is about.
    const kept = draft.releases.map((r) => r.title);
    expect(kept).toHaveLength(2);
    expect(kept).toContain("Batwara 1947");
    expect(kept).toContain("Awarapan 2");
  });

  it("the same line in the CAPTION is clean too", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [{ title: "Batwara 1947", body: "Sunny Deol and Aamir Khan share the frame." }],
        {
          caption:
            "Aamir Khan and Sunny Deol in the same Partition frame — Rajkumar Santoshi's " +
            "Batwara 1947, scored by A.R. Rahman, is THE theatre event of the weekend.",
          namesUsed: ["Aamir Khan", "Sunny Deol", "Rajkumar Santoshi", "A.R. Rahman"],
        }
      )
    );

    const draft = await generateWednesdayDrop([BATWARA], "theatrical", "2026-08-12", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
    expect(draft.releases.map((r) => r.title)).toEqual(["Batwara 1947"]);
  });

  it("the belt-and-braces half works alone: a NON-possessive \"Partition\" phrasing is also clean", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [{ title: "Batwara 1947", body: "A Partition love story carried by Sunny Deol." }],
        { namesUsed: ["Sunny Deol"] }
      )
    );

    const draft = await generateWednesdayDrop([BATWARA], "theatrical", "2026-08-12", "2026-08-16");
    expect(draft.nameFlags).toEqual([]);
    expect(draft.releases.map((r) => r.title)).toEqual(["Batwara 1947"]);
  });
});

describe("the two-strike drop machinery is UNCHANGED", () => {
  it("a genuinely unbacked name still retries once, then drops only that film and flags it", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Batwara 1947", body: "Rajkumar Santoshi's Partition epic, with Tabu." },
          { title: "Awarapan 2", body: "Emraan Hashmi returns." },
        ],
        { namesUsed: ["Rajkumar Santoshi", "Tabu", "Emraan Hashmi"] }
      )
    );

    const draft = await generateWednesdayDrop([BATWARA, AWARAPAN], "theatrical", "2026-08-12", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(2);                          // retry still fires
    expect(draft.releases.map((r) => r.title)).toEqual(["Awarapan 2"]); // only the offender drops

    // ONE flag for one hallucination. This previously emitted TWO — CAP_WORD
    // admits a trailing period, so a sentence-final name yields "Tabu." from the
    // sweep AND "Tabu" from namesUsed, and the old dedup key was the literal
    // name. WD-042 normalises trailing punctuation in the dedup key, so they
    // collapse and the punctuation-free label is the one kept.
    expect(draft.nameFlags).toHaveLength(1);
    const flag = draft.nameFlags[0]!;
    expect(flag).toContain("Tabu");
    expect(flag).toContain("DROPPED film");
    // The flag names the hallucination, NOT the director it sat beside.
    expect(flag).not.toContain("Rajkumar Santoshi");
  });

  it("the retry prompt names the real violation and not the possessive", async () => {
    mockCall
      .mockResolvedValueOnce(
        llmOut([{ title: "Batwara 1947", body: "Rajkumar Santoshi's Partition epic, with Tabu." }], {
          namesUsed: ["Rajkumar Santoshi", "Tabu"],
        })
      )
      .mockResolvedValueOnce(
        llmOut([{ title: "Batwara 1947", body: "Rajkumar Santoshi's Partition epic." }], {
          namesUsed: ["Rajkumar Santoshi"],
        })
      );

    const draft = await generateWednesdayDrop([BATWARA], "theatrical", "2026-08-12", "2026-08-16");

    const retryPrompt = String(mockCall.mock.calls[1]![0]);
    expect(retryPrompt).toContain('"Tabu"');
    expect(retryPrompt).not.toContain("Rajkumar Santoshi's Partition");
    expect(draft.nameFlags).toEqual([]);                                 // clean second pass
    expect(draft.releases.map((r) => r.title)).toEqual(["Batwara 1947"]);
  });
});
