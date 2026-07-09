// wednesday-drop.test.ts — copy NAME-DISCIPLINE (Phase 4). The LLM is mocked, so
// these are offline + deterministic. They prove: a person named in copy who is
// absent from the film data triggers ONE retry; a clean second response passes;
// a SECOND violation drops the offending film (never the whole run) and surfaces
// a nameFlag; and the belt-and-braces regex catches a name the model omits from
// namesUsed. Run: npx vitest run src/content/weekend/wednesday-drop.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop } from "./wednesday-drop.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mkRelease(p: { title: string; cast?: string[]; director?: string; leadCast?: string[]; platform?: string[] }): Release {
  return {
    id: `tmdb-${p.title}`, title: p.title, language: "Tamil", isSeries: false,
    platform: (p.platform ?? []) as Release["platform"], releaseDate: "2026-06-25",
    genre: ["Drama"], cast: p.cast ?? [], synopsis: "A film.", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-06-23T00:00:00.000Z",
    ...(p.director ? { director: p.director } : {}),
    ...(p.leadCast ? { leadCast: p.leadCast } : {}),
  };
}

/** Build a well-formed LLM output (cover + index + N release slides + cta). */
function llmOut(
  releaseSlides: Array<{ title: string; body: string }>,
  opts: { caption?: string; namesUsed?: string[] } = {}
) {
  return {
    caption: opts.caption ?? "A great weekend of Tamil cinema.",
    hashtags: ["#WeekendWatch", "#TamilCinema"],
    namesUsed: opts.namesUsed ?? [],
    carouselSlides: [
      { slideNumber: 1, type: "cover", title: "Cover", body: "sub", isMusicDirectorNotable: false },
      { slideNumber: 2, type: "index", title: "This weekend", body: "list", isMusicDirectorNotable: false },
      ...releaseSlides.map((r, i) => ({ slideNumber: i + 3, type: "release", title: r.title, body: r.body, isMusicDirectorNotable: false })),
      { slideNumber: releaseSlides.length + 3, type: "cta", title: "CTA", body: "which one?", isMusicDirectorNotable: false },
    ],
  };
}

const VAAZHAI = mkRelease({ title: "Vaazhai", cast: ["Dhanush"], leadCast: ["Dhanush"], director: "Mari Selvaraj", platform: ["Netflix"] });
const AMARAN = mkRelease({ title: "Amaran", cast: ["Sivakarthikeyan"], leadCast: ["Sivakarthikeyan"], platform: ["Netflix"] });

beforeEach(() => mockCall.mockReset());

describe("copy name-discipline — retry + drop", () => {
  it("TABU-STYLE: an out-of-data name → ONE retry → a clean second response passes (film kept, no flags)", async () => {
    mockCall
      .mockResolvedValueOnce(llmOut([{ title: "Vaazhai", body: "Dhanush and Tabu are electric" }], { namesUsed: ["Dhanush", "Tabu"] }))
      .mockResolvedValueOnce(llmOut([{ title: "Vaazhai", body: "Dhanush is superb" }], { namesUsed: ["Dhanush"] }));

    const draft = await generateWednesdayDrop([VAAZHAI], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                 // retry fired
    expect(draft.nameFlags).toEqual([]);                       // clean second pass
    expect(draft.releases.map((r) => r.title)).toEqual(["Vaazhai"]);
    // The retry prompt names the exact violation.
    expect(String(mockCall.mock.calls[1]![0])).toContain('"Tabu"');
  });

  it("TWO STRIKES: a persistent out-of-data name drops ONLY that film, keeps the rest, and flags it (never fails the run)", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Vaazhai", body: "Dhanush and Tabu are electric" },  // Tabu never in data
          { title: "Amaran", body: "Sivakarthikeyan leads" },
        ],
        { namesUsed: ["Dhanush", "Tabu", "Sivakarthikeyan"] }
      )
    );

    const draft = await generateWednesdayDrop([VAAZHAI, AMARAN], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                 // one retry, still bad → drop
    expect(draft.releases.map((r) => r.title)).toEqual(["Amaran"]);   // offending film dropped, other kept
    expect(draft.nameFlags).toHaveLength(1);
    expect(draft.nameFlags[0]).toContain("Tabu");
    expect(draft.nameFlags[0]).toContain("Vaazhai");
  });

  it("BELT-AND-BRACES: a name the model omits from namesUsed is caught by the 'starring <Name>' regex scan", async () => {
    mockCall
      .mockResolvedValueOnce(llmOut([{ title: "Vaazhai", body: "starring Tabu in a career best" }], { namesUsed: [] }))
      .mockResolvedValueOnce(llmOut([{ title: "Vaazhai", body: "Dhanush anchors it" }], { namesUsed: ["Dhanush"] }));

    const draft = await generateWednesdayDrop([VAAZHAI], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                 // regex-detected violation forced the retry
    expect(draft.nameFlags).toEqual([]);
  });

  it("CLEAN COPY: an in-data cast reference passes on the first call (no retry, no flags)", async () => {
    mockCall.mockResolvedValue(llmOut([{ title: "Vaazhai", body: "Dhanush is unforgettable" }], { namesUsed: ["Dhanush"] }));

    const draft = await generateWednesdayDrop([VAAZHAI], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
    expect(draft.releases.map((r) => r.title)).toEqual(["Vaazhai"]);
  });
});
