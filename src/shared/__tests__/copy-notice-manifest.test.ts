// WD-ENG-01 PARTS 1 & 3 — the receipt tells the truth about what the guard did.
//
// Issue 042's OTT manifest reported `ok: true` over six rows, with no indication
// anywhere that a SEVENTH film had been fed, picked by the model, and then
// deleted by the copy guard. The only record of Aroopi's removal was one string
// inside a draft JSON nobody opens. That is the gap these rows close.
//
//   copy-fallback → a WARN on the film's OWN row. The film shipped; only its
//                   blurb changed. Non-blocking by design.
//   copy-drop     → its own synthesized row, because the film has no row of its
//                   own any more. WARN when the scrub was certified, FAIL when
//                   it was not — and a FAIL takes `ok` false, which is what the
//                   4c render gate stops on.
import { describe, it, expect } from "vitest";
import {
  buildManifest,
  assertRenderable,
  EditionBlockedError,
  manifestToLog,
  manifestToSlack,
  type CopyNotice,
  type FilmInBucket,
} from "../post-validator.js";
import type { Release } from "../types.js";

const OTT_WINDOW = {
  ott: { start: "2026-08-10", end: "2026-08-16", dateField: "ott" as const, label: "Now Streaming" },
};

function mk(title: string, p: Partial<Release> = {}): Release {
  return {
    id: `tmdb-${title}`, title, language: "Malayalam", isSeries: false,
    platform: ["Prime Video"] as Release["platform"], releaseDate: "2026-08-14",
    releaseDates: { ott: "2026-08-14" },
    genre: ["Horror"], cast: ["A Actor"], leadCast: ["A Actor"],
    synopsis: "x".repeat(120), subtitleLanguages: [], sources: ["tmdb"],
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
    audioLanguages: { original: "Malayalam" },
    fetchedAt: "2026-08-13T00:00:00.000Z",
    ...p,
  } as Release;
}

const KATTALAN = mk("Kattalan");
const HEARTIN = mk("Heartin", { language: "Tamil", audioLanguages: { original: "Tamil" } });

const build = (films: Release[], copyNotices: CopyNotice[]) =>
  buildManifest(
    "Wed Drop · Now Streaming", "042",
    films.map((f): FilmInBucket => ({ film: f, bucket: "ott", whyLine: "A grounded reason to press play tonight." })),
    OTT_WINDOW,
    { copyNotices, copyNoticeBucket: "ott" },
    { cardType: "wed-drop", editionDate: "2026-08-13" }
  );

describe("no notices — byte-for-byte the old behaviour", () => {
  it("a clean edition is unchanged and still ok", () => {
    const m = build([KATTALAN, HEARTIN], []);
    expect(m.rows).toHaveLength(2);
    expect(m.failCount).toBe(0);
    expect(m.warnCount).toBe(0);
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });
});

describe("PART 1 — copy-fallback is a NON-BLOCKING warn on the film's own row", () => {
  const m = build([KATTALAN, HEARTIN], [
    { kind: "copy-fallback", title: "Kattalan", term: "Slow Burn Malayalam" },
  ]);

  it("does not add a row — the film shipped and already has one", () => {
    expect(m.rows).toHaveLength(2);
    expect(m.rows.map((r) => r.title).sort()).toEqual(["Heartin", "Kattalan"]);
  });

  it("warns on the right row, in the specified wording", () => {
    const row = m.rows.find((r) => r.title === "Kattalan")!;
    expect(row.status).toBe("warn");
    expect(row.reason).toContain("copy-fallback: Kattalan — Slow Burn Malayalam");
    expect(m.rows.find((r) => r.title === "Heartin")!.status).toBe("pass");
  });

  it("DOES NOT BLOCK — this is the whole point of Part 1", () => {
    expect(m.failCount).toBe(0);
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it("reaches the operator's log and Slack surfaces", () => {
    expect(manifestToLog(m)).toContain("copy-fallback: Kattalan");
    expect(manifestToSlack(m).issuesBlock).toContain("copy-fallback: Kattalan");
  });
});

describe("PART 3 — copy-drop gets its own row", () => {
  it("a CERTIFIED scrub warns loudly but still ships", () => {
    const m = build([KATTALAN, HEARTIN], [{ kind: "copy-drop", title: "Aroopi", term: "Tabu" }]);

    expect(m.rows).toHaveLength(3);                       // the drop is VISIBLE
    const row = m.rows.find((r) => r.title === "Aroopi")!;
    expect(row.status).toBe("warn");
    expect(row.id).toBe("copy-guard");
    expect(row.bucket).toBe("ott");
    expect(row.reason).toContain("copy-drop: Aroopi — Tabu");
    expect(row.reason).toContain("scrubbed clean");
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it("an UNCERTIFIED scrub FAILS the manifest and BLOCKS the edition", () => {
    const m = build([KATTALAN, HEARTIN], [
      { kind: "copy-drop", title: "Aroopi", term: "Tabu", scrubFailed: true },
    ]);

    const row = m.rows.find((r) => r.title === "Aroopi")!;
    expect(row.status).toBe("fail");
    expect(row.reason).toContain("could not be certified");
    expect(row.reason).toContain("edition blocked");
    expect(m.failCount).toBe(1);
    expect(m.ok).toBe(false);
    expect(() => assertRenderable(m)).toThrow(EditionBlockedError);
  });

  it("THE 042 RECEIPT, REBUILT: the seventh film is no longer invisible", () => {
    // Six shipped rows plus the drop — the manifest that shipped on Aug 13 had
    // six rows, ok:true, and no trace of Aroopi at all.
    const six = ["Kattalan", "Cocktail 2", "Aakhri Sawal", "Sarvagunn Sampann", "Bharat Bhhagya Viddhaata", "Heartin"]
      .map((t) => mk(t));
    const m = build(six, [{ kind: "copy-drop", title: "Aroopi", term: "Lights-off Malayalam" }]);
    expect(m.rows).toHaveLength(7);
    expect(m.rows.map((r) => r.title)).toContain("Aroopi");
    expect(manifestToLog(m)).toContain("Aroopi");
    expect(manifestToLog(m)).toContain("Lights-off Malayalam");
  });
});

describe("both kinds at once", () => {
  const m = build([KATTALAN, HEARTIN], [
    { kind: "copy-fallback", title: "Kattalan", term: "Slow Burn Malayalam" },
    { kind: "copy-drop", title: "Phantom Film", term: "Tabu", scrubFailed: true },
  ]);

  it("each lands in its own place and the FAIL wins the gate", () => {
    expect(m.rows.find((r) => r.title === "Kattalan")!.status).toBe("warn");
    expect(m.rows.find((r) => r.title === "Phantom Film")!.status).toBe("fail");
    expect(m.ok).toBe(false);
    expect(() => assertRenderable(m)).toThrow(EditionBlockedError);
  });
});
