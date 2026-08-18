// WD-ENG-11B — THE MANUAL-ADD DIAL.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// Real films exist with no TMDb record: Panchali Panchabhartruka (WD-ENG-07 —
// 33 live queries across 11 spellings, no record), Nijame Rujuvainadhi and
// Chargesheet 03-08 (WD-ENG-08 / 17C). WD-ENG-15 surveyed the whole source space
// and found nothing that closes the gap. This is the operator path.
//
// ── THE RULE IT DOES NOT RELAX ──────────────────────────────────────────────
// The TMDb-backed pool rule STANDS. WD-ENG-11's diagnosis found that an
// ExtractedFilm cannot carry the evidence and that a TMDb-less ai-net lead is
// hard-pinned RED with no Release. 11B's answer is a different entry point — a
// Release built from the evidence file, injected as a RECONCILED film — plus a
// tier bypass scoped so narrowly that an ai-net film cannot reach it. Both
// directions of that pin are asserted here.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readManualAdds,
  validateEntry,
  loadManualAdds,
  buildManualRelease,
  buildManualFilm,
  evidenceLabel,
  isOperatorAssertion,
  manualAddsPath,
  injectManualAdds,
  MANUAL_ADD_CAP,
  MANUAL_ADDS_DIR,
  type ManualEntry,
} from "../manual-adds.js";
import { assignTier, isManualAdd } from "../reconcile.js";
import { computeDropHash } from "../gate.js";
import { assertRenderable, buildManifest } from "../../shared/post-validator.js";
import { normalizeTitle } from "../../discovery/normalize.js";
import type { ReconciledFilm, ReconcileResult } from "../types.js";

// Panchali Panchabhartruka — the WD-ENG-11B replay case. wiki-list basis.
const PANCHALI: ManualEntry = {
  title: "Panchali Panchabhartruka",
  language: "Telugu",
  date: "2026-08-14",
  dateField: "theatrical",
  audioLanguages: { original: "Telugu" },
  sourceUrls: ["https://en.wikipedia.org/wiki/List_of_Telugu_films_of_2026"],
  evidenceBasis: "wiki-list",
  cast: ["Actor One", "Actor Two"],
  synopsis: "A shocking accident leaves four friends tangled in a deadly underworld mess.",
};

const OTT_ASSERTION: ManualEntry = {
  title: "Nijame Rujuvainadhi",
  language: "Telugu",
  date: "2026-08-14",
  dateField: "ott",
  audioLanguages: { original: "Telugu" },
  platform: "ETV Win",
  sourceUrls: ["https://www.etvwin.com/some-official-page"],
  evidenceBasis: "platform-official",
};

const WIKI_INDEX = new Map<string, string>([
  [normalizeTitle("Panchali Panchabhartruka"), "Telugu"],
  [normalizeTitle("Some Other Film"), "Telugu"],
]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-manual-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writeFile = (windowStart: string, entries: unknown[]) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${windowStart}.json`), JSON.stringify({ entries }), "utf8");
};

// ════════════════════════════════════════════════════════════════════════════
describe("the evidence file: location, shape, and loud refusals", () => {
  it("is WINDOW-START-keyed under data/manual-adds — NOT an env var, NOT issue-keyed", () => {
    // Sticky-env is why it is a file. WD-ENG-11C is why the key is the window
    // start and not the issue number: the issue number comes from an anchor keyed
    // by the gate hash, which does not exist yet at injection time, and the only
    // earlier source is a wall-clock helper two WD-ENG-02 pins forbid in this job.
    expect(MANUAL_ADDS_DIR).toBe("data/manual-adds");
    expect(manualAddsPath("2026-08-12")).toBe("data/manual-adds/2026-08-12.json");
  });

  it("A PREVIOUS WINDOW'S FILE IS NOT READ FOR THIS WINDOW", () => {
    writeFile("2026-08-05", [PANCHALI]);
    // This edition's window opens 2026-08-12; last week's declarations are
    // invisible to it. This is the sticky-env failure made structurally
    // impossible — the run looks for a filename last week's file does not have.
    expect(readManualAdds("2026-08-12", dir)).toEqual([]);
    expect(readManualAdds("2026-08-05", dir)).toHaveLength(1);
  });

  it("a missing file is the normal case — [] and no error", () => {
    expect(readManualAdds("2026-12-31", dir)).toEqual([]);
  });

  it("malformed JSON THROWS rather than silently skipping", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-08-12.json"), "{ not json", "utf8");
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(/not valid JSON/);
  });

  it.each([
    ["title", { ...PANCHALI, title: undefined }],
    ["language", { ...PANCHALI, language: undefined }],
    ["date", { ...PANCHALI, date: undefined }],
    ["dateField", { ...PANCHALI, dateField: undefined }],
    ["audioLanguages", { ...PANCHALI, audioLanguages: undefined }],
    ["sourceUrls", { ...PANCHALI, sourceUrls: undefined }],
    ["evidenceBasis", { ...PANCHALI, evidenceBasis: undefined }],
  ])("a missing required field (%s) is refused, and the message NAMES it", (field, entry) => {
    writeFile("2026-08-12", [entry]);
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(new RegExp(field));
  });

  it("a non-ISO date is refused by name", () => {
    writeFile("2026-08-12", [{ ...PANCHALI, date: "14 August 2026" }]);
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(/date.*YYYY-MM-DD/);
  });

  it("an empty sourceUrls array is refused — evidence is mandatory", () => {
    writeFile("2026-08-12", [{ ...PANCHALI, sourceUrls: [] }]);
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(/sourceUrls/);
  });

  it("THE HARD CAP — 3 entries fails the run LOUDLY and truncates nothing", () => {
    writeFile("2026-08-12", [PANCHALI, OTT_ASSERTION, { ...PANCHALI, title: "Third Film" }]);
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(/hard cap is 2/);
    expect(() => readManualAdds("2026-08-12", dir)).toThrow(/nothing was truncated/);
    expect(MANUAL_ADD_CAP).toBe(2);
  });

  it("exactly 2 is allowed — the cap is inclusive", () => {
    writeFile("2026-08-12", [PANCHALI, OTT_ASSERTION]);
    expect(readManualAdds("2026-08-12", dir)).toHaveLength(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("posterPath requires its own source URL", () => {
  it("posterPath WITHOUT posterSourceUrl is rejected", () => {
    const bad = { ...PANCHALI, posterPath: "https://cdn.example/poster.jpg" };
    expect(validateEntry(bad, WIKI_INDEX)).toMatch(/posterPath supplied without posterSourceUrl/);
  });

  it("posterPath WITH posterSourceUrl passes and reaches the Release", () => {
    const ok: ManualEntry = {
      ...PANCHALI,
      posterPath: "https://cdn.example/poster.jpg",
      posterSourceUrl: "https://en.wikipedia.org/wiki/Panchali",
    };
    expect(validateEntry(ok, WIKI_INDEX)).toBeNull();
    expect(buildManualRelease(ok).posterUrl).toBe("https://cdn.example/poster.jpg");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("wiki-list is MACHINE-VERIFIED — both directions", () => {
  it("a title IN the index verifies", () => {
    expect(validateEntry(PANCHALI, WIKI_INDEX)).toBeNull();
  });

  it("a title ABSENT from the index is REJECTED, and the message names it", () => {
    const bogus: ManualEntry = { ...PANCHALI, title: "Definitely Not A Real Film" };
    const problem = validateEntry(bogus, WIKI_INDEX);
    expect(problem).toMatch(/wiki-list.*NOT in the/s);
    expect(problem).toContain("Definitely Not A Real Film");
  });

  it("wiki-list claimed with NO index available cannot be verified, so it is refused", () => {
    // Fail closed: an unavailable check is not a passed check.
    expect(validateEntry(PANCHALI, undefined)).toMatch(/cannot verify/);
    expect(validateEntry(PANCHALI, new Map())).toMatch(/cannot verify/);
  });

  it("the OTHER two bases are NOT machine-checked — they need no index", () => {
    expect(validateEntry({ ...OTT_ASSERTION }, undefined)).toBeNull();
    expect(validateEntry({ ...PANCHALI, evidenceBasis: "trade-press" }, undefined)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("operator assertions are LABELLED UNVERIFIED everywhere", () => {
  it("isOperatorAssertion is true for exactly the two unverifiable bases", () => {
    expect(isOperatorAssertion("wiki-list")).toBe(false);
    expect(isOperatorAssertion("platform-official")).toBe(true);
    expect(isOperatorAssertion("trade-press")).toBe(true);
  });

  it.each([["platform-official"], ["trade-press"]] as const)(
    "%s carries UNVERIFIED OPERATOR ASSERTION in its label",
    (basis) => {
      const label = evidenceLabel({ ...PANCHALI, evidenceBasis: basis }, false);
      expect(label).toContain("UNVERIFIED OPERATOR ASSERTION");
      expect(label).toContain("not machine-checked");
    }
  );

  it("wiki-list says MACHINE-VERIFIED, and says so only when it really verified", () => {
    expect(evidenceLabel(PANCHALI, true)).toContain("MACHINE-VERIFIED");
    expect(evidenceLabel(PANCHALI, false)).toContain("VERIFICATION FAILED");
  });

  it("the label rides on the film, so review / manifest / logs cannot word it differently", () => {
    const f = buildManualFilm(OTT_ASSERTION, "ott", false);
    expect(f.manualAdd!.label).toContain("UNVERIFIED OPERATOR ASSERTION");
    expect(f.manualAdd!.assertion).toBe(true);
    expect(f.manualAdd!.verified).toBe(false);
  });

  it("an assertion-basis entry logs at WARN, a verified one at info", async () => {
    const { log } = await import("../../shared/logger.js");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const info = vi.spyOn(log, "info").mockImplementation(() => {});

    writeFile("2026-08-12", [OTT_ASSERTION]);
    loadManualAdds({ windowStart: "2026-08-12", pillar: "ott", wikiLanguageIndex: WIKI_INDEX, dir });
    expect(warn.mock.calls.some((c) => /UNVERIFIED OPERATOR ASSERTION/.test(String(c[0])))).toBe(true);

    vi.clearAllMocks();
    writeFile("2026-08-19", [PANCHALI]);
    loadManualAdds({ windowStart: "2026-08-19", pillar: "theatrical", wikiLanguageIndex: WIKI_INDEX, dir });
    expect(info.mock.calls.some((c) => /MACHINE-VERIFIED/.test(String(c[0])))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("THE TIER BYPASS IS NARROW — pinned in both directions", () => {
  it("a manual add is YELLOW / single-net, never red", () => {
    const f = buildManualFilm(PANCHALI, "theatrical", true);
    const { tier, reasons } = assignTier(f);
    expect(tier).toBe("yellow");
    expect(reasons).toContain("single-net");
    expect(reasons.join(" ")).toContain("operator-added");
  });

  it("🔒 AN AI-NET UNVERIFIED FILM IS STILL RED WITH NO RELEASE — the pin is narrowed, not removed", () => {
    const aiLead: ReconciledFilm = {
      title: "Hallucinated Film", language: "Unknown", pillar: "theatrical",
      dateSource: "none", foundIn: ["ai-net"], status: "unverified",
      tier: "red", reasons: [],
    } as ReconciledFilm;
    const { tier, reasons } = assignTier(aiLead);
    expect(tier).toBe("red");
    expect(reasons[0]).toMatch(/unverified — no TMDb match/);
    expect(aiLead.release).toBeUndefined();
  });

  it("the bypass needs BOTH conditions — foundIn exactly ['manual'] AND the evidence record", () => {
    const withoutEvidence = { ...buildManualFilm(PANCHALI, "theatrical", true) };
    delete withoutEvidence.manualAdd;
    expect(isManualAdd(withoutEvidence)).toBe(false);
    expect(assignTier(withoutEvidence).tier).toBe("red");   // falls back to the pin

    const taggedButMixed = buildManualFilm(PANCHALI, "theatrical", true);
    taggedButMixed.foundIn = ["manual", "ai-net"];
    expect(isManualAdd(taggedButMixed)).toBe(false);
    expect(assignTier(taggedButMixed).tier).toBe("red");
  });

  it("NO evidence basis promotes a manual film to green — corroboration never upgrades", () => {
    for (const basis of ["wiki-list", "platform-official", "trade-press"] as const) {
      const f = buildManualFilm({ ...PANCHALI, evidenceBasis: basis }, "theatrical", true);
      expect(assignTier(f).tier, basis).toBe("yellow");
    }
    // Structural reason: green requires tmdb+ai-net, and foundIn is ["manual"].
    const f = buildManualFilm(PANCHALI, "theatrical", true);
    expect(f.foundIn).toEqual(["manual"]);
  });

  it("a manual film whose landing FAILS still goes red — the bypass is not a shield", () => {
    const f = buildManualFilm(PANCHALI, "theatrical", true);
    f.landingStatus = "fail";
    expect(assignTier(f).tier).toBe("red");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("the Release is real and satisfies BOTH failing contracts", () => {
  it("carries releaseDates on the pillar's own field — contract:band-released", () => {
    expect(buildManualRelease(PANCHALI).releaseDates).toEqual({ theatrical: "2026-08-14" });
    expect(buildManualRelease(OTT_ASSERTION).releaseDates).toEqual({ ott: "2026-08-14" });
  });

  it("carries audioLanguages.original — contract:band-available-in", () => {
    expect(buildManualRelease(PANCHALI).audioLanguages?.original).toBe("Telugu");
  });

  it("🔒 A MANUAL FILM PASSES THE MANIFEST — it would actually render", () => {
    const release = buildManualRelease(PANCHALI);
    const manifest = buildManifest(
      "Wed Drop · In Theaters", "042",
      [{ film: release, bucket: "theatrical", whyLine: "A tense Telugu thriller worth the ticket." }],
      { theatrical: { start: "2026-08-12", end: "2026-08-16", dateField: "theatrical", label: "In Theaters" } },
      {}, { cardType: "wed-drop", editionDate: "2026-08-14" }
    );
    const row = manifest.rows.find((r) => r.title === "Panchali Panchabhartruka")!;
    expect(row.status).not.toBe("fail");
    expect(manifest.ok).toBe(true);
    expect(() => assertRenderable(manifest)).not.toThrow();
  });

  it("invents nothing — absent optional fields stay absent", () => {
    const bare = buildManualRelease(OTT_ASSERTION);
    expect(bare.synopsis).toBe("");
    expect(bare.cast).toEqual([]);
    expect(bare.director).toBeUndefined();
    expect(bare.posterUrl).toBeUndefined();
    expect(bare.runtime).toBeUndefined();
    expect(bare.genre).toEqual([]);
  });

  it("the id is namespaced so it can never collide with a tmdb- id", () => {
    expect(buildManualRelease(PANCHALI).id).toMatch(/^manual-/);
    expect(buildManualRelease(PANCHALI).sources).toEqual(["manual"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("the gate hash covers manual entries", () => {
  const deck = (extra: ReconciledFilm[]): ReconcileResult[] => [
    {
      pillar: "theatrical",
      window: { start: "2026-08-12", end: "2026-08-16" },
      reconciled: [
        {
          title: "Ordinary Film", language: "Telugu", pillar: "theatrical", tmdbId: 1,
          dateSource: "tmdb", date: "2026-08-14", foundIn: ["tmdb", "ai-net"],
          status: "confirmed", tier: "green", reasons: [],
        } as ReconciledFilm,
        ...extra,
      ],
      rejected: [], counts: {} as never,
    },
  ];

  it("SAME DECK + a manual entry ⇒ a DIFFERENT hash", () => {
    const without = computeDropHash(deck([]));
    const with_ = computeDropHash(deck([buildManualFilm(PANCHALI, "theatrical", true)]));
    expect(with_).not.toBe(without);
  });

  it("the hash is stable for the same manual entry — approve must survive a re-run", () => {
    const a = computeDropHash(deck([buildManualFilm(PANCHALI, "theatrical", true)]));
    const b = computeDropHash(deck([buildManualFilm(PANCHALI, "theatrical", true)]));
    expect(a).toBe(b);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("loadManualAdds — the seam", () => {
  it("routes an entry to its pillar by dateField, and never to the other one", () => {
    writeFile("2026-08-12", [PANCHALI, OTT_ASSERTION]);
    const th = loadManualAdds({ windowStart: "2026-08-12", pillar: "theatrical", wikiLanguageIndex: WIKI_INDEX, dir });
    const ott = loadManualAdds({ windowStart: "2026-08-12", pillar: "ott", wikiLanguageIndex: WIKI_INDEX, dir });

    expect(th.films.map((f) => f.title)).toEqual(["Panchali Panchabhartruka"]);
    expect(ott.films.map((f) => f.title)).toEqual(["Nijame Rujuvainadhi"]);
  });

  it("a failed-validation entry is REJECTED, not silently yellowed", () => {
    writeFile("2026-08-12", [{ ...PANCHALI, title: "Not In The Index" }]);
    const out = loadManualAdds({ windowStart: "2026-08-12", pillar: "theatrical", wikiLanguageIndex: WIKI_INDEX, dir });

    expect(out.films).toEqual([]);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]!.reason).toMatch(/NOT in the/);
  });

  it("an ott entry with no platform is refused — the card would show TBA", () => {
    writeFile("2026-08-12", [{ ...OTT_ASSERTION, platform: undefined }]);
    const out = loadManualAdds({ windowStart: "2026-08-12", pillar: "ott", wikiLanguageIndex: WIKI_INDEX, dir });
    expect(out.films).toEqual([]);
    expect(out.rejected[0]!.reason).toMatch(/requires a platform/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("the manual path cannot leak into a non-Wednesday pillar", () => {
  it("WEDNESDAY IS THE ONLY CALLER — no other pillar can reach the dial", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const callers: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts") || p.includes("__tests__") || p.endsWith("manual-adds.ts")) continue;
        if (/(loadManualAdds|injectManualAdds)\s*\(/.test(readFileSync(p, "utf8"))) callers.push(p.replace(/\\/g, "/"));
      }
    };
    walk(join(process.cwd(), "src"));
    const rel = callers.map((c) => c.slice(c.indexOf("src/")));
    // Exactly one caller, and it is Wednesday. A Sat/Sun/Mon/Fri caller — or a
    // second Wednesday call site — fails this outright.
    expect(rel).toEqual(["src/jobs/wednesday-drop.ts"]);
  });

  it("the other four pillar jobs do not import the module at all", async () => {
    const { readFileSync } = await import("node:fs");
    for (const job of [
      "monday-movement", "saturday-verdict", "sunday-spotlight", "friday-archives", "thursday-compare",
    ]) {
      const src = readFileSync(join(process.cwd(), `src/jobs/${job}.ts`), "utf8");
      expect(src, job).not.toContain("manual-adds");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WD-ENG-11C — THE WIRED PATH. injectManualAdds is the exact function the job
// calls, so these drive it directly rather than a similar-looking rewrite.
describe("injectManualAdds — the job seam", () => {
  const result = (pillar: string) => ({
    pillar,
    reconciled: [
      {
        title: "Ordinary Film", language: "Telugu", pillar, tmdbId: 1,
        dateSource: "tmdb", date: "2026-08-14", foundIn: ["tmdb", "ai-net"],
        status: "confirmed", tier: "green", reasons: [],
      } as ReconciledFilm,
    ],
    rejected: [] as Array<{ title?: string; reason: string }>,
  });

  it("🔒 injects into the matching pillar and NOWHERE ELSE", () => {
    writeFile("2026-08-12", [PANCHALI, OTT_ASSERTION]);
    const th = result("theatrical");
    const ott = result("ott");

    const out = injectManualAdds([th, ott], {
      windowStart: "2026-08-12", wikiLanguageIndex: WIKI_INDEX, dir,
    });

    expect(out.injected).toBe(2);
    expect(th.reconciled.map((f) => f.title)).toEqual(["Ordinary Film", "Panchali Panchabhartruka"]);
    expect(ott.reconciled.map((f) => f.title)).toEqual(["Ordinary Film", "Nijame Rujuvainadhi"]);
    // THE LEAK PIN: neither entry reaches the other edition.
    expect(th.reconciled.some((f) => f.title === "Nijame Rujuvainadhi")).toBe(false);
    expect(ott.reconciled.some((f) => f.title === "Panchali Panchabhartruka")).toBe(false);
  });

  it("a refused entry lands in the pillar's rejected list, never in reconciled", () => {
    writeFile("2026-08-12", [{ ...PANCHALI, title: "Not In The Index" }]);
    const th = result("theatrical");

    const out = injectManualAdds([th], { windowStart: "2026-08-12", wikiLanguageIndex: WIKI_INDEX, dir });

    expect(out.injected).toBe(0);
    expect(out.refused).toBe(1);
    expect(th.reconciled).toHaveLength(1);
    expect(th.rejected[0]!.reason).toMatch(/manual-add refused .*NOT in the/);
  });

  it("THE CAP FAILS LOUDLY THROUGH THE WIRED PATH — the run stops, nothing truncates", () => {
    writeFile("2026-08-12", [PANCHALI, OTT_ASSERTION, { ...PANCHALI, title: "Third Film" }]);
    expect(() =>
      injectManualAdds([result("theatrical")], { windowStart: "2026-08-12", wikiLanguageIndex: WIKI_INDEX, dir })
    ).toThrow(/hard cap is 2/);
  });

  it("A PREVIOUS WINDOW'S FILE IS NOT READ through the wired path either", () => {
    writeFile("2026-08-05", [PANCHALI]);
    const th = result("theatrical");
    const out = injectManualAdds([th], { windowStart: "2026-08-12", wikiLanguageIndex: WIKI_INDEX, dir });
    expect(out.injected).toBe(0);
    expect(th.reconciled).toHaveLength(1);
  });

  it("no file at all is a silent no-op — the overwhelmingly common case", () => {
    const th = result("theatrical");
    const out = injectManualAdds([th], { windowStart: "2026-08-12", wikiLanguageIndex: WIKI_INDEX, dir });
    expect(out).toEqual({ injected: 0, refused: 0 });
    expect(th.reconciled).toHaveLength(1);
  });

  it("the job keys on startDate, reads no wall clock, and injects BEFORE the gate", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "src/jobs/wednesday-drop.ts"), "utf8");
    expect(src).toContain("injectManualAdds(results, { windowStart: startDate");
    // Two standing WD-ENG-02 pins forbid this helper in this file. Asserted here
    // too, so a future edit to the dial cannot quietly reintroduce it.
    expect(src).not.toContain("getIssueNumberForToday");
    // Injection must precede the gate or the hash would not cover it.
    expect(src.indexOf("injectManualAdds(")).toBeLessThan(src.indexOf("const decision = decideGate("));
  });
});
