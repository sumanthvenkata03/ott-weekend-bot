// WD-ENG-02 item 4 — PERSISTING THE ANCHOR MUST NOT PERTURB THE APPROVE HASH.
//
// The whole fix rests on one property: phase 2 can find phase 1's anchor because
// both phases agree on the hash. If writing the anchor moved the hash, the very
// act of anchoring would invalidate every outstanding --approve token — and the
// operator's typed hash would stop matching the deck it was issued for.
//
// It cannot, structurally: computeDropHash reduces film fingerprints and nothing
// else, and the anchor is a separate file that no hash input reads. This file
// pins that rather than assuming it, because "structurally impossible" is a claim
// with a shelf life.
//
// Mock preamble mirrors gate-shared.test.ts — gate.ts constructs a Notion client
// at module load, so it must be constructable and config must be present.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@notionhq/client", () => ({
  Client: class {
    pages = { create: async () => ({ id: "page1", url: "https://notion.example/page1" }) };
    blocks = { children: { append: async () => {} } };
  },
}));
vi.mock("ofetch", () => ({ ofetch: vi.fn(async () => ({})) }));
vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "x", NOTION_RELEASES_DB_ID: "db", SLACK_WEBHOOK_URL: "" },
}));

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeDropHash } from "../gate.js";
import { resolveIssueNumber, type IssueAnchorWindows } from "../../shared/issue-anchor.js";
import { __resetLogTee } from "../../shared/logger.js";
import type { ReconciledFilm, ReconcileResult } from "../types.js";

function rf(p: Partial<ReconciledFilm> & { title: string; pillar: string }): ReconciledFilm {
  return { language: "Tamil", dateSource: "tmdb", foundIn: ["tmdb"], status: "confirmed", tier: "green", reasons: [], ...p };
}
function result(pillar: string, films: ReconciledFilm[]): ReconcileResult {
  return {
    pillar,
    window: { start: "2026-06-22", end: "2026-06-28" },
    reconciled: films,
    rejected: [],
    counts: { total: films.length, green: films.filter((f) => f.tier === "green").length, yellow: films.filter((f) => f.tier === "yellow").length, red: 0, addedByAiNet: 0, flagged: 0 },
  };
}

// The SAME fixed two-edition fixture gate-shared.test.ts pins to "92bcfb40772d".
const FIXED: ReconcileResult[] = [
  result("theatrical", [rf({ title: "T1", pillar: "theatrical", tmdbId: 11, tier: "green", date: "2026-06-26", dateSource: "tmdb", foundIn: ["tmdb", "ai-net"], status: "confirmed" })]),
  result("ott", [rf({ title: "O1", pillar: "ott", tmdbId: 22, tier: "yellow", date: "2026-06-25", dateSource: "press", foundIn: ["ai-net"], status: "confirmed" })]),
];

const WINDOWS: IssueAnchorWindows = {
  theatrical: { start: "2026-06-24", end: "2026-06-28" },
  ott: { start: "2026-06-22", end: "2026-06-28" },
};

let dir: string;
const prevTee = process.env.TBSI_LOG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-anchor-hash-"));
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

describe("the approve hash is untouched by anchoring", () => {
  it("🔒 the pinned regression value still holds with the anchor feature present", () => {
    expect(computeDropHash(FIXED)).toBe("92bcfb40772d");
  });

  it("the SAME reconciled deck hashes identically before and after the anchor is written", () => {
    const before = computeDropHash(FIXED);

    const r = resolveIssueNumber({
      hash: before, isApprove: false, windows: WINDOWS,
      now: new Date("2026-08-12T18:00:00Z"), dir,
    });
    expect(r.source).toBe("created");
    expect(readdirSync(dir).filter((f) => f.endsWith("-anchor.json"))).toHaveLength(1);

    expect(computeDropHash(FIXED)).toBe(before);
    expect(computeDropHash(FIXED)).toBe("92bcfb40772d");
  });

  it("the phase-2 read is a no-op on the hash too", () => {
    const h = computeDropHash(FIXED);
    resolveIssueNumber({ hash: h, isApprove: false, windows: WINDOWS, now: new Date("2026-08-12T18:00:00Z"), dir });
    const approved = resolveIssueNumber({
      hash: h, isApprove: true, windows: WINDOWS,
      now: new Date("2026-08-12T19:00:00Z"), dir,
    });
    expect(approved.source).toBe("anchored");
    expect(computeDropHash(FIXED)).toBe(h);
  });

  it("resolveIssueNumber does not mutate the results it was derived from", () => {
    const snapshot = JSON.stringify(FIXED);
    resolveIssueNumber({ hash: computeDropHash(FIXED), isApprove: false, windows: WINDOWS, now: new Date("2026-08-12T18:00:00Z"), dir });
    expect(JSON.stringify(FIXED)).toBe(snapshot);
  });

  it("the anchor is a SEPARATE artifact — no hash input can reach it", () => {
    // computeDropHash takes exactly one argument (the results) and reads no
    // filesystem state, so an anchor on disk is unreachable from it by construction.
    expect(computeDropHash.length).toBe(1);
    const withAnchorOnDisk = computeDropHash(FIXED);
    resolveIssueNumber({ hash: "unrelated-hash", isApprove: false, windows: WINDOWS, now: new Date("2026-08-12T18:00:00Z"), dir });
    expect(computeDropHash(FIXED)).toBe(withAnchorOnDisk);
  });
});
