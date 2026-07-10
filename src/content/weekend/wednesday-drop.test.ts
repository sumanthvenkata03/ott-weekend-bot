// wednesday-drop.test.ts — copy NAME-DISCIPLINE (Phase 4). The LLM is mocked, so
// these are offline + deterministic. They prove: a person named in copy who is
// absent from the film data triggers ONE retry; a clean second response passes;
// a SECOND violation drops the offending film (never the whole run) and surfaces
// a nameFlag; and the belt-and-braces regex catches a name the model omits from
// namesUsed. Run: npx vitest run src/content/weekend/wednesday-drop.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop, parseLangOverrides, applyLangOverrides } from "./wednesday-drop.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mkRelease(p: {
  title: string; cast?: string[]; director?: string; leadCast?: string[];
  platform?: string[]; musicDirector?: string; tbsiScore?: number;
}): Release {
  return {
    id: `tmdb-${p.title}`, title: p.title, language: "Tamil", isSeries: false,
    platform: (p.platform ?? []) as Release["platform"], releaseDate: "2026-06-25",
    genre: ["Drama"], cast: p.cast ?? [], synopsis: "A film.", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-06-23T00:00:00.000Z",
    ...(p.director ? { director: p.director } : {}),
    ...(p.leadCast ? { leadCast: p.leadCast } : {}),
    ...(p.musicDirector ? { musicDirector: p.musicDirector } : {}),
    ...(p.tbsiScore !== undefined ? { tbsiScore: p.tbsiScore } : {}),
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

// ── Name Sweep v2 — the two PRODUCTION escapes + strict-backing + false positives ──
// These are the fixtures that motivated v2. v1 (namesUsed self-report + a narrow
// "starring <Name>" regex) let both real escapes through; v2 sweeps the text.
describe("name sweep v2 — production fixtures + strict backing", () => {
  it("PROD ESCAPE 1 (Tabu): 'Ayushmann Khurrana and Tabu…' — Tabu not in data, omitted from namesUsed → flagged", async () => {
    const film = mkRelease({ title: "Dream Girl 2", cast: ["Ayushmann Khurrana"], leadCast: ["Ayushmann Khurrana"], platform: ["Netflix"] });
    mockCall.mockResolvedValue(
      llmOut(
        [{ title: "Dream Girl 2", body: "Ayushmann Khurrana and Tabu spin one bad decision into weekend-long chaos." }],
        { namesUsed: ["Ayushmann Khurrana"] } // Tabu omitted, exactly as it slipped through in production
      )
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                       // "and Tabu" (join-trigger) forced the retry
    expect(draft.nameFlags).toHaveLength(1);                         // only Tabu — the real lead is untouched
    expect(draft.nameFlags[0]).toContain("Tabu");
    expect(draft.nameFlags[0]).toContain("Dream Girl 2");
    expect(String(mockCall.mock.calls[1]![0])).toContain('"Tabu"');  // retry names the exact violation
  });

  it("PROD ESCAPE 2 (Madhuri): 'Ajay Devgn, Anil Kapoor and Madhuri Dixit…' — only Madhuri flagged (Anil is a real credit)", async () => {
    const film = mkRelease({ title: "Total Dhamaal", cast: ["Ajay Devgn", "Anil Kapoor"], leadCast: ["Ajay Devgn"] });
    mockCall.mockResolvedValue(
      llmOut(
        [{ title: "Total Dhamaal", body: "Ajay Devgn, Anil Kapoor and Madhuri Dixit chase the Treasure of Life for one last score." }],
        { namesUsed: ["Ajay Devgn", "Anil Kapoor"] } // Madhuri omitted; comma/"and" joins defeated v1's regex
      )
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(draft.nameFlags).toHaveLength(1);
    expect(draft.nameFlags[0]).toContain("Madhuri Dixit");
    expect(draft.nameFlags[0]).toContain("Total Dhamaal");
    expect(draft.nameFlags[0]).not.toContain("Ajay");               // real ensemble members are NOT flagged
    expect(draft.nameFlags[0]).not.toContain("Anil");
  });

  it("DECISION 2 (strict backing): 'Shahid Kapoor' with only Janhvi Kapoor in the edition → flagged (surname can't launder)", async () => {
    const film = mkRelease({ title: "Ulajh", cast: ["Janhvi Kapoor"], leadCast: ["Janhvi Kapoor"] });
    mockCall.mockResolvedValue(
      llmOut([{ title: "Ulajh", body: "Shahid Kapoor headlines with real intensity." }], { namesUsed: ["Shahid Kapoor"] })
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                       // v1's any-token leniency would have LAUNDERED this via "kapoor"
    expect(draft.nameFlags.some((f) => f.includes("Shahid Kapoor"))).toBe(true);
  });

  it("REAL ENSEMBLE MEMBER: 'Anil Kapoor' with Anil Kapoor in cast → passes (no retry)", async () => {
    const film = mkRelease({ title: "Fighter", cast: ["Anil Kapoor", "Hrithik Roshan"], leadCast: ["Hrithik Roshan"] });
    mockCall.mockResolvedValue(
      llmOut([{ title: "Fighter", body: "Anil Kapoor is in commanding form here." }], { namesUsed: ["Anil Kapoor"] })
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
  });

  it("NON-NAME CAP: 'Prayagraj' with no join-trigger → passes (single caps are never flagged alone)", async () => {
    const film = mkRelease({ title: "Stree 2", cast: ["Rajkummar Rao"], leadCast: ["Rajkummar Rao"] });
    mockCall.mockResolvedValue(
      llmOut([{ title: "Stree 2", body: "Expect full Prayagraj comic chaos from start to finish." }], { namesUsed: [] })
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
  });

  it("INITIALS: 'music by S. Thaman' with Thaman as the musicDirector → passes", async () => {
    const film = mkRelease({ title: "Game Changer", cast: ["Ram Charan"], leadCast: ["Ram Charan"], musicDirector: "Thaman S." });
    mockCall.mockResolvedValue(
      llmOut([{ title: "Game Changer", body: "The music by S. Thaman is the real hook." }], { namesUsed: ["S. Thaman"] })
    );

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
  });

  it("NAMESUSED OMISSION: a real cast member named in copy but left out of namesUsed → retry (self-report can't launder)", async () => {
    const film = mkRelease({ title: "Jawan", cast: ["Nayanthara", "Vijay Sethupathi"], leadCast: ["Nayanthara"] });
    mockCall
      .mockResolvedValueOnce(llmOut([{ title: "Jawan", body: "Vijay Sethupathi makes a magnetic villain." }], { namesUsed: [] }))
      .mockResolvedValueOnce(llmOut([{ title: "Jawan", body: "Vijay Sethupathi makes a magnetic villain." }], { namesUsed: ["Vijay Sethupathi"] }));

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);                       // undeclared real name forced a retry
    expect(draft.nameFlags).toEqual([]);                            // declaring it on the retry clears it
  });
});

// ── Superlative Guard (Phase 2) — a "top/highest/best-rated" claim must belong to
// the edition's strict-max tbsiScore film. "our top pick" (curation) is NOT gated. ──
describe("superlative guard (Phase 2)", () => {
  it("FALSE claim: 'top-rated' on a film that isn't the strict-max tbsiScore → retry naming the true leader", async () => {
    const a = mkRelease({ title: "Kalki 2898 AD", cast: ["Prabhas"], leadCast: ["Prabhas"], tbsiScore: 7.4 });
    const b = mkRelease({ title: "Maharaja", cast: ["Vijay Sethupathi"], leadCast: ["Vijay Sethupathi"], tbsiScore: 8.6 });
    mockCall
      .mockResolvedValueOnce(llmOut(
        [
          { title: "Kalki 2898 AD", body: "Our top-rated pick of the weekend, no contest." }, // false: 7.4 < 8.6
          { title: "Maharaja", body: "A tight, gripping thriller." },
        ],
        { namesUsed: [] }
      ))
      .mockResolvedValueOnce(llmOut(
        [
          { title: "Kalki 2898 AD", body: "Spectacle cinema at its biggest." },
          { title: "Maharaja", body: "A tight, gripping thriller." },
        ],
        { namesUsed: [] }
      ));

    const draft = await generateWednesdayDrop([a, b], "ott", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(String(mockCall.mock.calls[1]![0])).toContain("Maharaja"); // retry names the actual leader
    expect(draft.nameFlags).toEqual([]);
  });

  it("TRUE claim: the strict-max tbsiScore film using 'highest-rated' → passes (no retry)", async () => {
    const a = mkRelease({ title: "Kalki 2898 AD", cast: ["Prabhas"], leadCast: ["Prabhas"], tbsiScore: 7.4 });
    const b = mkRelease({ title: "Maharaja", cast: ["Vijay Sethupathi"], leadCast: ["Vijay Sethupathi"], tbsiScore: 8.6 });
    mockCall.mockResolvedValue(llmOut(
      [
        { title: "Maharaja", body: "The highest-rated drama on the slate this week." },
        { title: "Kalki 2898 AD", body: "Blockbuster spectacle, start to finish." },
      ],
      { namesUsed: [] }
    ));

    const draft = await generateWednesdayDrop([a, b], "ott", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
  });

  it("UNSCORED claim: a 'best-rated' claim on a film with no tbsiScore → retry (a rating claim needs a score)", async () => {
    const film = mkRelease({ title: "Indian 2", cast: ["Kamal Haasan"], leadCast: ["Kamal Haasan"] }); // no tbsiScore
    mockCall
      .mockResolvedValueOnce(llmOut([{ title: "Indian 2", body: "The best-rated action film you will catch this week." }], { namesUsed: [] }))
      .mockResolvedValueOnce(llmOut([{ title: "Indian 2", body: "Big-scale vigilante action." }], { namesUsed: [] }));

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(draft.nameFlags).toEqual([]);
  });

  it("CURATION, not a rating: bare 'our top pick' (no 'rated') on an unscored film → passes", async () => {
    const film = mkRelease({ title: "Indian 2", cast: ["Kamal Haasan"], leadCast: ["Kamal Haasan"] });
    mockCall.mockResolvedValue(llmOut([{ title: "Indian 2", body: "Our top pick to start the weekend with." }], { namesUsed: [] }));

    const draft = await generateWednesdayDrop([film], "theatrical", "2026-06-24", "2026-06-28");

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
  });
});

// ── WED_DROP_LANG override (Phase 3) — operator dial mirroring WED_DROP_PLATFORM. ──
describe("WED_DROP_LANG override (Phase 3)", () => {
  it("parse: ';'-separated Title=Lang1|Lang2 → first is original, rest dubbed; a single lang emits no dubbed key", () => {
    const m = parseLangOverrides("Homebound=Malayalam|Tamil|Telugu; Vaazhai=Tamil");
    expect(m.get("homebound")).toEqual({ original: "Malayalam", dubbed: ["Tamil", "Telugu"] });
    expect(m.get("vaazhai")).toEqual({ original: "Tamil" });
    expect(m.get("vaazhai")).not.toHaveProperty("dubbed");
    expect(parseLangOverrides(undefined).size).toBe(0);
    expect(parseLangOverrides("garbage-with-no-equals").size).toBe(0);
  });

  it("apply: replaces audioLanguages on the matching film (title case-insensitive) and counts it", () => {
    const pool = [mkRelease({ title: "Homebound" }), mkRelease({ title: "Vaazhai" })];
    const { pool: out, applied } = applyLangOverrides(pool, parseLangOverrides("homebound=Malayalam|Tamil"));
    expect(applied).toBe(1);
    expect(out[0]!.audioLanguages).toEqual({ original: "Malayalam", dubbed: ["Tamil"] });
    expect(out[1]!.audioLanguages).toBeUndefined();
  });

  it("no-match no-op: a title absent from the pool changes nothing (applied 0)", () => {
    const pool = [mkRelease({ title: "Vaazhai" })];
    const { pool: out, applied } = applyLangOverrides(pool, parseLangOverrides("Nonexistent=Hindi"));
    expect(applied).toBe(0);
    expect(out[0]!.audioLanguages).toBeUndefined();
  });
});
