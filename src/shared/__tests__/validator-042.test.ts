// WD-042 Part 4 — the validator tells the truth, then gates on it.
//
// Issue 042's OTT manifest was ok:false with 4 failures, and every one of them
// was the validator misreading its own product:
//   Cocktail 2 / Bharat Bhhagya Viddhaata / Heartin — "score shown with no real
//     vote base" on cards that had CORRECTLY printed the NEW stamp;
//   Aakhri Sawal — "pre-release-seal" on a film that played cinemas on 15 May.
// Fixtures below are those six films verbatim from
// output/runs/wed-drop-ott-2026-08-13-draft.json.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildManifest,
  assertRenderable,
  EditionBlockedError,
  type FilmInBucket,
} from "../post-validator.js";
import { awardsNumericSeal, hasRealVoteBase } from "../seal-decision.js";
import { buildStampContext } from "../../rendering/_shared.js";
import type { Release } from "../types.js";

const EDITION_DATE = "2026-08-13";
const OTT_WINDOW = {
  ott: { start: "2026-08-10", end: "2026-08-16", dateField: "ott" as const, label: "Now Streaming" },
};

function mk(p: Partial<Release> & { title: string }): Release {
  return {
    id: `tmdb-${p.title}`, language: "Hindi", isSeries: false,
    platform: ["ZEE5"] as Release["platform"], releaseDate: "2026-08-14",
    genre: ["Drama"], cast: ["A Actor", "B Actor"], leadCast: ["A Actor", "B Actor"],
    synopsis: "x".repeat(120), subtitleLanguages: [], sources: ["tmdb"],
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
    audioLanguages: { original: "Hindi" },
    fetchedAt: "2026-08-13T00:00:00.000Z",
    ...p,
  } as Release;
}

// ── Issue 042's six OTT films, verbatim ──
const KATTALAN = mk({ title: "Kattalan", language: "Malayalam", platform: ["ManoramaMAX"] as Release["platform"], releaseDate: "2026-08-13", releaseDates: { theatrical: "2026-05-28", ott: "2026-08-13" }, imdbRating: 8.3, tmdbVoteAverage: 6.75, tmdbVoteCount: 6, tbsiScore: 6.8, tbsiSourceCount: 2, letterboxd: 2.6 });
const COCKTAIL_2 = mk({ title: "Cocktail 2", platform: ["Netflix"] as Release["platform"], releaseDates: { theatrical: "2026-06-19", ott: "2026-08-14" }, imdbRating: 7.6, tmdbVoteAverage: 5.75, tmdbVoteCount: 20, tbsiScore: 6.3, tbsiSourceCount: 2, rottenTomatoes: 23, letterboxd: 2.5 });
const AAKHRI = mk({ title: "Aakhri Sawal", platform: ["Lionsgate Play"] as Release["platform"], releaseDates: { theatrical: "2026-05-15", ott: "2026-08-14" }, imdbRating: 6.3, imdbVotes: 10192, tmdbVoteAverage: 1, tmdbVoteCount: 1, tbsiScore: 6.3, tbsiSourceCount: 1 });
const SARVAGUNN = mk({ title: "Sarvagunn Sampann", releaseDates: { ott: "2026-08-14" }, tmdbVoteAverage: 0, tmdbVoteCount: 0 });
const BHARAT = mk({ title: "Bharat Bhhagya Viddhaata", releaseDates: { theatrical: "2026-06-12", ott: "2026-08-14" }, imdbRating: 7, tmdbVoteAverage: 0, tmdbVoteCount: 0, tbsiScore: 7, tbsiSourceCount: 1 });
const HEARTIN = mk({ title: "Heartin", language: "Tamil", platform: ["Prime Video"] as Release["platform"], releaseDates: { theatrical: "2026-06-26", ott: "2026-08-14" }, imdbRating: 7.5, tmdbVoteAverage: 6, tmdbVoteCount: 2, tbsiScore: 7.5, tbsiSourceCount: 1 });

const OTT_SIX = [KATTALAN, COCKTAIL_2, AAKHRI, SARVAGUNN, BHARAT, HEARTIN];

const ottManifest = (films: Release[]) =>
  buildManifest(
    "Wed Drop · Now Streaming", "042",
    films.map((f): FilmInBucket => ({ film: f, bucket: "ott", whyLine: "A grounded reason to watch this weekend, at length." })),
    OTT_WINDOW, {}, { cardType: "wed-drop", editionDate: EDITION_DATE }
  );

describe("4d — tonight's six OTT films: zero failures, edition renders", () => {
  const m = ottManifest(OTT_SIX);

  it("ZERO failures and the edition is renderable", () => {
    const failures = m.rows.filter((r) => r.status === "fail").map((r) => `${r.title}: ${r.reason}`);
    expect(failures).toEqual([]);
    expect(m.failCount).toBe(0);
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it.each(OTT_SIX.filter((f) => f.title !== "Aakhri Sawal").map((f) => [f.title]))(
    "%s passes clean",
    (title) => {
      expect(m.rows.find((r) => r.title === title)!.status).toBe("pass");
    }
  );

  // The one non-pass is NOT a score or date problem — it is Part 5a reporting
  // that Lionsgate Play has no logo asset. Non-blocking by design, and it is the
  // warn that replaced Issue 042's silent empty white box.
  it("Aakhri Sawal's only remark is the missing Lionsgate Play mark", () => {
    const row = m.rows.find((r) => r.title === "Aakhri Sawal")!;
    expect(row.status).toBe("warn");
    expect(row.reason).toBe("platform-logo-missing: lionsgate-play — card ships the text-only platform line");
  });

  it("no row mentions a score or pre-release problem any more", () => {
    for (const row of m.rows) {
      expect(row.reason, row.title).not.toContain("score shown with no real vote base");
      expect(row.reason, row.title).not.toContain("pre-release-seal");
    }
  });
});

describe("4a — score honesty is keyed to the RENDER, not the record", () => {
  it("a data-score with a NEW stamp PASSES, and says so", () => {
    // Heartin: tbsiScore 7.5 in the record, 2 TMDb votes → the card prints NEW.
    expect(buildStampContext(HEARTIN).stampKind).toBe("new");
    expect(awardsNumericSeal(HEARTIN)).toBe(false);
    const row = ottManifest([HEARTIN]).rows[0]!;
    expect(row.status).toBe("pass");
    expect(row.reason).toContain("score withheld — no vote base");
  });

  it("the verifier and the renderer agree on all six", () => {
    for (const f of OTT_SIX) {
      const prints = buildStampContext(f).stampKind !== "new";
      expect(awardsNumericSeal(f), f.title).toBe(prints);
    }
  });

  it("a film that legitimately shows a seal carries no score remark", () => {
    expect(buildStampContext(AAKHRI).stampKind).toBe("tbsi");
    const row = ottManifest([AAKHRI]).rows[0]!;
    expect(row.status).not.toBe("fail");
    expect(row.reason).not.toContain("score withheld");
    expect(row.reason).not.toContain("score shown with no real vote base");
  });

  it("TRIPWIRE: 'seal without vote base' is currently UNREACHABLE, and the check is still there", () => {
    // The two predicates cannot contradict each other today: awardsNumericSeal's
    // tbsi branch requires hasRealVoteBase outright, and its tmdb branch requires
    // tmdbVoteCount >= 50, which satisfies hasRealVoteBase by itself. Proven by
    // sweeping the whole boundary rather than asserted in prose.
    for (let votes = 0; votes <= 120; votes++) {
      for (const imdbVotes of [0, 1, 500]) {
        for (const tbsiScore of [undefined, 7.5]) {
          const f = { tmdbVoteAverage: 7.5, tmdbVoteCount: votes, imdbVotes, ...(tbsiScore !== undefined ? { tbsiScore } : {}) };
          if (awardsNumericSeal(f)) {
            expect(hasRealVoteBase(f), `votes=${votes} imdbVotes=${imdbVotes}`).toBe(true);
          }
        }
      }
    }
    // …and the FAIL branch survives in source, so loosening the seal trips the
    // manifest instead of silently shipping an unearned number.
    const src = readFileSync(join(process.cwd(), "src/shared/post-validator.ts"), "utf8");
    expect(src).toContain("score shown with no real vote base");
    expect(src).toContain("if (showsNumber && !voteBaseOf(film))");
  });
});

describe("4b — pre-release-seal no longer fires on a film that played cinemas", () => {
  it("Aakhri Sawal (theatrical 15 May, OTT 14 Aug) is not pre-release", () => {
    const row = ottManifest([AAKHRI]).rows[0]!;
    expect(row.status).not.toBe("fail");
    expect(row.reason).not.toContain("pre-release-seal");
  });

  it("a TRUE never-released film showing a number still FAILS", () => {
    const neverReleased = mk({
      title: "Phantom Premiere",
      releaseDates: { ott: "2026-08-14" },          // no theatrical date at all
      tbsiScore: 8.1, imdbRating: 8.1, imdbVotes: 900,   // and a real vote base
    });
    const row = ottManifest([neverReleased]).rows[0]!;
    expect(awardsNumericSeal(neverReleased)).toBe(true);
    expect(row.status).toBe("fail");
    expect(row.reason).toContain("pre-release-seal");
  });

  it("a FUTURE theatrical date does not count as having played", () => {
    const future = mk({
      title: "Later",
      releaseDates: { theatrical: "2026-12-01", ott: "2026-08-14" },
      tbsiScore: 8.1, imdbRating: 8.1, imdbVotes: 900,
    });
    expect(ottManifest([future]).rows[0]!.status).toBe("fail");
  });
});

describe("4c — ok:false hard-blocks the edition, with no bypass", () => {
  it("assertRenderable throws EditionBlockedError on a failing manifest", () => {
    const bad = ottManifest([
      mk({ title: "Phantom", releaseDates: { ott: "2026-08-14" }, tbsiScore: 8.1, imdbRating: 8.1, imdbVotes: 900 }),
    ]);
    expect(bad.ok).toBe(false);
    expect(() => assertRenderable(bad)).toThrow(EditionBlockedError);
    expect(() => assertRenderable(bad)).toThrow(/BLOCKED/);
    expect(() => assertRenderable(bad)).toThrow(/Nothing rendered, nothing uploaded/);
  });

  it("the thrown error carries the manifest so the job can print the receipt", () => {
    const bad = ottManifest([mk({ title: "Phantom", releaseDates: { ott: "2026-08-14" }, tbsiScore: 8.1, imdbRating: 8.1, imdbVotes: 900 })]);
    try {
      assertRenderable(bad);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(EditionBlockedError);
      expect((err as EditionBlockedError).manifest.failCount).toBeGreaterThan(0);
    }
  });

  it("a clean manifest passes straight through", () => {
    expect(() => assertRenderable(ottManifest(OTT_SIX))).not.toThrow();
  });

  it("there is NO bypass flag — assertRenderable takes only the manifest", () => {
    expect(assertRenderable.length).toBe(1);
  });

  it("the gate is wired BEFORE the render call in the job", () => {
    // Source-level pin, wiring-pins idiom: the block must precede renderWedDrop.
    const src = readFileSync(join(process.cwd(), "src/jobs/wednesday-drop.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const body = src.slice(src.indexOf("async function produceEdition"));
    expect(body.indexOf("assertRenderable(manifest)")).toBeGreaterThan(-1);
    expect(body.indexOf("assertRenderable(manifest)")).toBeLessThan(body.indexOf("await renderWedDrop("));
    expect(body.indexOf("assertRenderable(manifest)")).toBeLessThan(body.indexOf("uploadPngsToR2("));
  });
});

describe("4d — non-blocking warns stay non-blocking", () => {
  it("a missing poster warns and does NOT block", () => {
    const noPoster = mk({ title: "Posterless", releaseDates: { ott: "2026-08-14" } });
    delete (noPoster as { posterUrl?: string }).posterUrl;
    const m = ottManifest([noPoster]);
    expect(m.rows[0]!.status).toBe("warn");
    expect(m.rows[0]!.reason).toContain("contract:poster");
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it("a missing cast warns and does NOT block", () => {
    const noCast = mk({ title: "Castless", releaseDates: { ott: "2026-08-14" }, cast: [], leadCast: [] });
    const m = ottManifest([noCast]);
    expect(m.rows[0]!.status).toBe("warn");
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it("warns and a real failure together still block (the failure wins)", () => {
    const noPoster = mk({ title: "Posterless", releaseDates: { ott: "2026-08-14" } });
    delete (noPoster as { posterUrl?: string }).posterUrl;
    const phantom = mk({ title: "Phantom", releaseDates: { ott: "2026-08-14" }, tbsiScore: 8.1, imdbRating: 8.1, imdbVotes: 900 });
    const m = ottManifest([noPoster, phantom]);
    expect(m.ok).toBe(false);
    expect(() => assertRenderable(m)).toThrow(EditionBlockedError);
  });
});
