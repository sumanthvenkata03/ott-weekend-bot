// WD-042 — the name guard stops striking names that ARE in the film data.
//
// Issue 042's OTT pass-1 struck five people who were all backed by this
// edition's own card data — Vaani Kapoor and Ishwak Singh (Sarvagunn Sampann
// leadCast), Pritam (Cocktail 2 musicDirector "Pritam Chakraborty"), Rajesh
// Murugesan (Heartin musicDirector) and Gopi Sundar (Aroopi musicDirector) —
// because the model had omitted them from its self-reported namesUsed. The
// only genuinely unbacked candidate was "A Yakshini", a Kerala-folklore noun
// phrase, and it 2-struck Aroopi out of the deck.
//
// Fixtures are the REAL name fields from output/runs/wed-drop-ott-2026-08-13-*.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../claude.js", () => ({ callClaudeJSON: vi.fn() }));

import { callClaudeJSON } from "../claude.js";
import { generateWednesdayDrop } from "./wednesday-drop.js";
import type { Release } from "../../shared/types.js";

const mockCall = vi.mocked(callClaudeJSON);

function mkRelease(p: {
  title: string; cast?: string[]; leadCast?: string[];
  director?: string; musicDirector?: string;
}): Release {
  return {
    id: `tmdb-${p.title}`, title: p.title, language: "Hindi", isSeries: false,
    platform: ["ZEE5"] as Release["platform"], releaseDate: "2026-08-14",
    genre: ["Drama"], cast: p.cast ?? [], synopsis: "A film.", subtitleLanguages: [],
    sources: ["tmdb"], fetchedAt: "2026-08-13T00:00:00.000Z",
    ...(p.leadCast ? { leadCast: p.leadCast } : {}),
    ...(p.director ? { director: p.director } : {}),
    ...(p.musicDirector ? { musicDirector: p.musicDirector } : {}),
  };
}

// ── Issue 042's real OTT edition, name fields verbatim ──
const SARVAGUNN = mkRelease({ title: "Sarvagunn Sampann", leadCast: ["Vaani Kapoor", "Ishwak Singh"] });
const COCKTAIL_2 = mkRelease({
  title: "Cocktail 2",
  cast: ["Amitabh Bachchan", "Kriti Sanon", "Rashmika Mandanna"],
  leadCast: ["Kriti Sanon", "Shahid Kapoor"],
  director: "Homi Adajania",
  musicDirector: "Pritam Chakraborty",
});
const HEARTIN = mkRelease({
  title: "Heartin",
  cast: ["Sananth", "Madonna Sebastian", "Emaya T"],
  leadCast: ["Madonna Sebastian", "Sananth"],
  director: "Kishore Kumar",
  musicDirector: "Rajesh Murugesan",
});
const AROOPI = mkRelease({ title: "Aroopi", leadCast: ["Neha Chawla", "Vysakh Ravi"], musicDirector: "Gopi Sundar" });

const EDITION = [SARVAGUNN, COCKTAIL_2, HEARTIN, AROOPI];

function llmOut(
  releaseSlides: Array<{ title: string; body: string }>,
  opts: { caption?: string; namesUsed?: string[] } = {}
) {
  return {
    caption: opts.caption ?? "A stacked week of streaming arrivals.",
    hashtags: ["#NowStreaming"],
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

describe("tonight's seven pass-1 strike strings are all clean now", () => {
  it("ALL of them in one pass, with namesUsed EMPTY → zero violations, zero retry, nothing dropped", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Sarvagunn Sampann", body: "Vaani Kapoor and Ishwak Singh lead this one." },
          { title: "Cocktail 2", body: "Pritam is back on the soundtrack." },
          { title: "Heartin", body: "Rajesh Murugesan scores it beautifully." },
          { title: "Aroopi", body: "A Yakshini haunts the house. Music by Gopi Sundar." },
        ],
        { namesUsed: [] } // the exact bookkeeping slip that used to cost films
      )
    );

    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(1);        // NO retry
    expect(draft.nameFlags).toEqual([]);             // NO flags
    expect(draft.releases.map((r) => r.title).sort()).toEqual(
      ["Aroopi", "Cocktail 2", "Heartin", "Sarvagunn Sampann"]
    );                                                // NOTHING dropped
  });

  it.each([
    ["Vaani Kapoor", "Sarvagunn Sampann", "Vaani Kapoor is the draw here."],
    ["Ishwak Singh", "Sarvagunn Sampann", "Ishwak Singh anchors the second half."],
    ["Pritam", "Cocktail 2", "The soundtrack, with Pritam, is the reason to press play."],
    ["Rajesh Murugesan", "Heartin", "Rajesh Murugesan scores it beautifully."],
    ["Gopi Sundar.", "Aroopi", "The mood is set by Gopi Sundar."],
    ["Gopi Sundar", "Aroopi", "Gopi Sundar and the sound design carry it."],
    ["A Yakshini", "Aroopi", "A Yakshini haunts the old house."],
  ])("%s @%s → clean", async (_name, title, body) => {
    mockCall.mockResolvedValue(llmOut([{ title, body }], { namesUsed: [] }));
    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(draft.nameFlags).toEqual([]);
    expect(draft.releases.map((r) => r.title)).toContain(title);
  });

  it("the real Aroopi blurb that dropped the film now survives", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [{ title: "Aroopi", body: "A Yakshini stalks a Kerala homestead — Gopi Sundar's score does the haunting." }],
        { namesUsed: [] }
      )
    );
    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");
    expect(draft.nameFlags).toEqual([]);
    expect(draft.releases.map((r) => r.title)).toContain("Aroopi");
  });
});

describe("the guard did NOT go soft — an unbacked person still strikes and still drops", () => {
  it("an unbacked name retries once, then drops that film on the second strike", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Cocktail 2", body: "Pritam scores it, and Tabu steals every scene." },
          { title: "Heartin", body: "Rajesh Murugesan scores it beautifully." },
        ],
        { namesUsed: [] }
      )
    );

    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");

    expect(mockCall).toHaveBeenCalledTimes(2);                            // retry still fires
    expect(draft.releases.map((r) => r.title)).toEqual(["Heartin"]);      // only the offender drops
    expect(draft.nameFlags).toHaveLength(1);
    expect(draft.nameFlags[0]).toContain("Tabu");
    expect(draft.nameFlags[0]).toContain("DROPPED film");
    // The backed names it sat beside are NOT named in the flag.
    for (const backed of ["Pritam", "Rajesh Murugesan"]) {
      expect(draft.nameFlags[0]).not.toContain(backed);
    }
  });

  it("a cross-person blend is still unbacked and still strikes", async () => {
    // {vaani, singh} is a subset of NO single person's full name.
    mockCall.mockResolvedValue(
      llmOut([{ title: "Sarvagunn Sampann", body: "Vaani Singh carries the film." }], { namesUsed: [] })
    );
    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });

  it("a declared-but-unbacked name is still caught — self-report cannot launder", async () => {
    mockCall.mockResolvedValue(
      llmOut([{ title: "Heartin", body: "A quiet romance." }], { namesUsed: ["Tabu"] })
    );
    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");
    expect(mockCall).toHaveBeenCalledTimes(2);
  });
});

describe("the false message can no longer be emitted for a backed name", () => {
  it("no nameFlag ever says \"not in film data\" about a film-data-backed person", async () => {
    mockCall.mockResolvedValue(
      llmOut(
        [
          { title: "Cocktail 2", body: "Pritam scores it, and Tabu steals every scene." },
          { title: "Heartin", body: "Rajesh Murugesan scores it beautifully." },
        ],
        { namesUsed: [] }
      )
    );
    const draft = await generateWednesdayDrop(EDITION, "ott", "2026-08-10", "2026-08-16");

    const backedPeople = [
      "Vaani Kapoor", "Ishwak Singh", "Pritam", "Rajesh Murugesan", "Gopi Sundar",
      "Kriti Sanon", "Homi Adajania", "Madonna Sebastian",
    ];
    for (const flag of draft.nameFlags) {
      if (!flag.includes("not in film data")) continue;
      for (const person of backedPeople) {
        expect(flag, `"${person}" must never be reported as not-in-film-data`).not.toContain(person);
      }
    }
  });
});
