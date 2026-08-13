// WD-ENG-02 — the issue number belongs to the EDITION, not to the wall clock.
//
// THE CATASTROPHE, of which this file is the fixture:
// Wed Drop is the only two-phase pillar. Phase 1 reconciles and emits an approve
// hash, then STOPS. Phase 2 (`--approve <hash>`) re-runs everything and renders.
// Both phases used to call getIssueNumberForToday() independently, so a gate
// created before IST midnight and approved after it produced TWO issue numbers
// for ONE edition. The ledger held the deck's films under phase 1's number; the
// render phase asked excludedKeysFor({ excludeIssue: <phase 2's number> }); the
// self-exemption that exists precisely so an edition cannot dedup itself did not
// match — and the deck excluded its own films.
//
// IST is UTC+5:30, so IST midnight is 18:30Z. The two instants below straddle it
// by thirty minutes on either side, and land on real posting days (Aug 12 is a
// Wednesday, Aug 13 a Thursday) so the numbers genuinely differ: 041 vs 042.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveIssueNumber,
  readIssueAnchor,
  issueAnchorPath,
  type IssueAnchorWindows,
} from "../issue-anchor.js";
import { getIssueNumber } from "../issue-number.js";
import { editorialDateUTC } from "../editorial-clock.js";
import { selectExcludedKeys, laneFor, filmKey, type FeaturedRow } from "../featured-ledger.js";
import { log, __resetLogTee } from "../logger.js";

// ── The Aug 12/13 2026 IST-midnight boundary ────────────────────────────────
const GATE_AT = new Date("2026-08-12T18:00:00Z");     // IST Aug 12, 23:30 — before
const APPROVE_AT = new Date("2026-08-12T19:00:00Z");  // IST Aug 13, 00:30 — after
const HASH = "a1b2c3d4e5f6";

const WINDOWS: IssueAnchorWindows = {
  theatrical: { start: "2026-08-12", end: "2026-08-16" },
  ott: { start: "2026-08-10", end: "2026-08-16" },
};

let dir: string;
const prevTee = process.env.TBSI_LOG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-anchor-"));
  delete process.env.TBSI_LOG_FILE;
  __resetLogTee();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (prevTee === undefined) delete process.env.TBSI_LOG_FILE;
  else process.env.TBSI_LOG_FILE = prevTee;
  __resetLogTee();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const gate = (now: Date, hash = HASH) =>
  resolveIssueNumber({ hash, isApprove: false, windows: WINDOWS, now, dir });
const approve = (now: Date, hash = HASH) =>
  resolveIssueNumber({ hash, isApprove: true, windows: WINDOWS, now, dir });

// ════════════════════════════════════════════════════════════════════════════
describe("the boundary is real — the two phases genuinely disagreed", () => {
  it("wall-clock numbering differs across IST midnight by one", () => {
    expect(getIssueNumber(editorialDateUTC(GATE_AT))).toBe("041");
    expect(getIssueNumber(editorialDateUTC(APPROVE_AT))).toBe("042");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("THE WD-042 REGRESSION — gate before IST midnight, approve after", () => {
  // The six films the OTT deck actually shipped.
  const DECK = ["Kattalan", "Cocktail 2", "Aakhri Sawal", "Sarvagunn Sampann", "Bharat Bhhagya Viddhaata", "Heartin"]
    .map((title, i) => ({ title, tmdbId: 1000 + i }));

  /** The ledger rows phase 1 wrote for this deck, under the anchored number. */
  const ledgerRows = (issue: string): FeaturedRow[] =>
    DECK.map((f) => ({
      film_key: filmKey(f),
      pillar: "wed-ott",
      issue,
      featured_at: GATE_AT.getTime(),
      title: f.title,
    }));

  /** The dedup question produceEdition asks: which of the deck's films are out? */
  const dedupDrops = (rows: FeaturedRow[], excludeIssue: string) => {
    const excluded = selectExcludedKeys(rows, {
      lane: laneFor("wed-ott"),
      cooldownDays: 14,
      now: APPROVE_AT.getTime(),
      excludeIssue,
    });
    return DECK.filter((f) => excluded.has(filmKey(f))).map((f) => f.title);
  };

  it("phase 1 anchors the number to the gate and persists it", () => {
    const r = gate(GATE_AT);
    expect(r).toEqual({ issueNumber: "041", source: "created" });
    expect(existsSync(issueAnchorPath(HASH, dir))).toBe(true);
  });

  it("phase 2, AFTER midnight, reads the SAME number — the fix", () => {
    gate(GATE_AT);
    const r = approve(APPROVE_AT);
    expect(r).toEqual({ issueNumber: "041", source: "anchored" });
  });

  it("THE FIX: the self-exemption matches, dedup drops ZERO, the full deck renders", () => {
    const anchored = gate(GATE_AT).issueNumber;          // 041
    const rows = ledgerRows(anchored);                    // ledger holds 041 rows
    const renderIssue = approve(APPROVE_AT).issueNumber;  // still 041

    expect(renderIssue).toBe(anchored);
    expect(dedupDrops(rows, renderIssue)).toEqual([]);    // NOTHING self-excluded
  });

  it("THE CATASTROPHE, reproduced: with wall-clock numbering the deck excludes ITSELF", () => {
    // This is the pre-fix control. It is asserted, not described, so the failure
    // mode stays visible in the suite rather than living only in a post-mortem.
    const rows = ledgerRows("041");                                       // phase 1 wrote 041
    const wallClock = getIssueNumber(editorialDateUTC(APPROVE_AT));       // phase 2 computed 042

    expect(wallClock).toBe("042");
    expect(wallClock).not.toBe("041");
    expect(dedupDrops(rows, wallClock)).toEqual(DECK.map((f) => f.title)); // ALL SIX gone
  });

  it("ledger rows from the cross-midnight approve land under N, not N+1", () => {
    gate(GATE_AT);
    const issue = approve(APPROVE_AT).issueNumber;
    // recordFeatured(films, pillar, issueNumber) is called with exactly this.
    expect(issue).toBe("041");
    for (const row of ledgerRows(issue)) expect(row.issue).toBe("041");
  });

  it("idempotent under INSERT OR REPLACE: re-approving rewrites the SAME primary key", () => {
    gate(GATE_AT);
    const first = approve(APPROVE_AT).issueNumber;
    const second = approve(new Date("2026-08-13T09:00:00Z")).issueNumber;   // later still
    expect(second).toBe(first);
    // PRIMARY KEY (film_key, pillar, issue) — a stable issue keeps the key stable,
    // so a re-approve replaces its own rows instead of adding a parallel set.
    const keys = (issue: string) => ledgerRows(issue).map((r) => `${r.film_key}|${r.pillar}|${r.issue}`);
    expect(keys(second)).toEqual(keys(first));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("same-day re-approve — unchanged behaviour", () => {
  it("same number, same source, no second anchor written", () => {
    expect(gate(GATE_AT)).toEqual({ issueNumber: "041", source: "created" });
    const sameDay = new Date("2026-08-12T18:20:00Z");                       // still IST Aug 12
    expect(approve(sameDay)).toEqual({ issueNumber: "041", source: "anchored" });
    expect(readdirSync(dir).filter((f) => f.endsWith("-anchor.json"))).toHaveLength(1);
  });

  it("the anchor is WRITE-ONCE — a re-gate never re-stamps an existing hash", () => {
    gate(GATE_AT);
    const before = readFileSync(issueAnchorPath(HASH, dir), "utf8");
    gate(APPROVE_AT);                                                       // next day, same hash
    expect(readFileSync(issueAnchorPath(HASH, dir), "utf8")).toBe(before);
  });

  it("a DIFFERENT hash gets its own anchor — a changed deck is a new edition", () => {
    expect(gate(GATE_AT, "hash-one").issueNumber).toBe("041");
    expect(gate(APPROVE_AT, "hash-two").issueNumber).toBe("042");
    expect(readIssueAnchor("hash-one", dir)!.issueNumber).toBe("041");
    expect(readIssueAnchor("hash-two", dir)!.issueNumber).toBe("042");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("backward compatibility — a missing anchor is LOUD, never silent", () => {
  it("an --approve run with no anchor falls back to the wall clock and warns", () => {
    const r = approve(APPROVE_AT);
    expect(r).toEqual({ issueNumber: "042", source: "wall-clock-fallback" });
  });

  it("the warn line reaches the persisted run log (WD-ENG-01 Part 4)", () => {
    process.env.TBSI_LOG_FILE = join(dir, "run.log");
    __resetLogTee();

    const r = approve(APPROVE_AT);

    const body = readFileSync(join(dir, "run.log"), "utf8");
    expect(body).toContain("issue anchor missing — falling back to wall-clock №042");
    expect(body).toContain("WARN");
    expect(r.source).toBe("wall-clock-fallback");
  });

  it("the fallback does NOT persist an anchor — the warning must repeat, not be silenced", () => {
    approve(APPROVE_AT);
    expect(existsSync(issueAnchorPath(HASH, dir))).toBe(false);
    // Still loud on the next re-approve.
    expect(approve(APPROVE_AT).source).toBe("wall-clock-fallback");
  });

  it("a corrupt or number-less anchor file is treated as absent, not as undefined", () => {
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(issueAnchorPath(HASH, dir), "{ not json", "utf8");
    expect(readIssueAnchor(HASH, dir)).toBeNull();
    expect(approve(APPROVE_AT).source).toBe("wall-clock-fallback");

    writeFileSync(issueAnchorPath(HASH, dir), JSON.stringify({ hash: HASH, windows: WINDOWS }), "utf8");
    expect(readIssueAnchor(HASH, dir)).toBeNull();
    expect(approve(APPROVE_AT).source).toBe("wall-clock-fallback");
  });

  it("a fresh GATE run creating its anchor is silent — only --approve warns", () => {
    process.env.TBSI_LOG_FILE = join(dir, "run.log");
    __resetLogTee();
    gate(GATE_AT);
    expect(readFileSync(join(dir, "run.log"), "utf8")).not.toContain("issue anchor missing");
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("formatting is preserved end-to-end", () => {
  it("PREVIEW survives the anchor round-trip", () => {
    const pre = new Date("2026-05-31T12:00:00Z");                            // pre-launch
    expect(gate(pre, "pre-launch-hash")).toEqual({ issueNumber: "PREVIEW", source: "created" });
    expect(approve(new Date("2026-06-01T12:00:00Z"), "pre-launch-hash"))
      .toEqual({ issueNumber: "PREVIEW", source: "anchored" });
  });

  it("zero padding survives — the anchor stores the STRING, never a number", () => {
    const early = new Date("2026-06-17T12:00:00Z");                          // issue 001
    expect(gate(early, "h001").issueNumber).toBe("001");
    const raw = JSON.parse(readFileSync(issueAnchorPath("h001", dir), "utf8"));
    expect(raw.issueNumber).toBe("001");
    expect(typeof raw.issueNumber).toBe("string");
    expect(approve(new Date("2026-06-18T12:00:00Z"), "h001").issueNumber).toBe("001");
  });

  it("the anchor records the hash, the windows and the IST date it was computed from", () => {
    gate(GATE_AT);
    const a = readIssueAnchor(HASH, dir)!;
    expect(a.hash).toBe(HASH);
    expect(a.issueNumber).toBe("041");
    expect(a.anchoredDate).toBe("2026-08-12");
    expect(a.windows).toEqual(WINDOWS);
    expect(a.anchoredAt).toBe(GATE_AT.toISOString());
  });

  it("the anchor lives beside the run JSONs and the run log", () => {
    expect(issueAnchorPath(HASH)).toBe(`output/runs/wed-drop-gate-${HASH}-anchor.json`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("SCOPE PIN — only Wed Drop is anchored; the other pillars are untouched", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  const SINGLE_PHASE = [
    "src/jobs/monday-movement.ts",
    "src/jobs/saturday-verdict.ts",
    "src/jobs/sunday-spotlight.ts",
  ];

  it.each(SINGLE_PHASE)("%s still uses wall-clock numbering, unchanged", (f) => {
    const src = code(read(f));
    // These pillars compute AND publish in one process, so wall-clock is correct
    // for them. Anchoring would be pure churn with a migration cost.
    expect(src).toContain("getIssueNumberForToday()");
    expect(src).not.toContain("issue-anchor");
    expect(src).not.toContain("resolveIssueNumber");
  });

  it("Wed Drop is the ONLY caller of the anchor, and no longer calls the wall clock", () => {
    const wed = code(read("src/jobs/wednesday-drop.ts"));
    expect(wed).toContain("resolveIssueNumber(");
    expect(wed).not.toContain("getIssueNumberForToday(");

    const others = SINGLE_PHASE.filter((f) => code(read(f)).includes("resolveIssueNumber"));
    expect(others).toEqual([]);
  });

  it("issue-number.ts itself is untouched — the anchor wraps it, never replaces it", () => {
    const src = code(read("src/shared/issue-number.ts"));
    expect(src).toContain("export function getIssueNumber(");
    expect(src).toContain("export function getIssueNumberForToday(");
    expect(src).toContain('padStart(3, "0")');
    expect(src).toContain('return "PREVIEW"');
  });

  it("corner-stamp date logic is NOT touched by this packet", () => {
    // Cards keep printing the IST RENDER date. The anchor carries the issue
    // NUMBER only; it exposes no date to the renderer.
    const wed = code(read("src/jobs/wednesday-drop.ts"));
    expect(wed).toContain("const dateStr = editorialTodayStamp();");
    expect(code(read("src/shared/issue-anchor.ts"))).not.toContain("editorialTodayStamp");
  });
});
