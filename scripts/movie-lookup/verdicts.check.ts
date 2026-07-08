// scripts/movie-lookup/verdicts.check.ts
// Tool-local tests for the verdict-bridge exporter's pure functions + the server's
// defensive verdicts.json reader. Named *.check.ts so the repo's default `npx vitest
// run` never collects them. Run:
//   npx vitest run --config scripts/movie-lookup/vitest.config.ts
//
// Offline + pure — no archive, no network, no filesystem writes (safeReadVerdicts is
// exercised against a guaranteed-missing path). deriveIssue is verified against
// getIssueNumber's own table (Sat 2026-07-04 → issue "013").

import { describe, it, expect } from "vitest";
import {
  parseLogLines, latestPerFilm, deriveIssue, mergeVerdicts, safeReadVerdicts, toRow,
  type LogEntry, type VerdictRow,
} from "./verdicts-export.js";

describe("verdicts export — parseLogLines", () => {
  it("parses JSONL, skipping blank + malformed lines", () => {
    const text = [
      `{"runAt":"2026-07-04T22:10:17.086Z","title":"Alpha","imdbId":"tt1","criticCount":4,"tbsiScore":4,"star":2,"verdict":"Skip","confidence":"high"}`,
      ``,
      `not json`,
      `{"runAt":"2026-07-04T20:00:00.000Z","title":"Beta","criticCount":6,"tbsiScore":72,"star":3.5,"verdict":"Worth a Try","confidence":"medium"}`,
    ].join("\n");
    const e = parseLogLines(text);
    expect(e.map((x) => x.title)).toEqual(["Alpha", "Beta"]);
    expect(e[0]!.imdbId).toBe("tt1");
    expect(e[1]!.imdbId).toBeUndefined(); // the second line has no imdbId
  });
});

describe("verdicts export — latestPerFilm", () => {
  const mk = (o: Partial<LogEntry>): LogEntry => ({ runAt: "2026-07-04T00:00:00.000Z", title: "X", criticCount: 1, tbsiScore: 1, star: 1, verdict: "Skip", confidence: "high", ...o });
  it("keeps the newest per film (key imdbId else title) and drops verdict===null", () => {
    const entries = [
      mk({ imdbId: "tt1", title: "A", runAt: "2026-07-01T00:00:00.000Z", verdict: "Skip" }),
      mk({ imdbId: "tt1", title: "A", runAt: "2026-07-05T00:00:00.000Z", verdict: "Worth a Try" }), // newer wins
      mk({ title: "NoId", runAt: "2026-07-02T00:00:00.000Z", verdict: "Divisive" }),                // keyed by title
      mk({ imdbId: "tt9", title: "NoScore", verdict: null }),                                       // dropped
    ];
    const out = latestPerFilm(entries);
    const byKey = Object.fromEntries(out.map((e) => [e.imdbId ?? "title:" + e.title, e.verdict]));
    expect(byKey["tt1"]).toBe("Worth a Try");
    expect(byKey["title:NoId"]).toBe("Divisive");
    expect(out.some((e) => e.title === "NoScore")).toBe(false); // verdict===null dropped
  });
});

describe("verdicts export — deriveIssue (UTC; verdict Saturday → getIssueNumber)", () => {
  it("Fri 2026-07-03 → Sat 2026-07-04 → issue 013 (matches issue-number.ts's table)", () => {
    expect(deriveIssue("2026-07-03T22:10:00.000Z")).toBe("013");
  });
  it("Sat stays same day; Sun maps back one day — same Saturday issue", () => {
    expect(deriveIssue("2026-07-04T10:00:00.000Z")).toBe("013"); // Sat → +0
    expect(deriveIssue("2026-07-05T10:00:00.000Z")).toBe("013"); // Sun → −1 → Sat Jul 4
  });
  it("a mid-week run maps forward to the coming Saturday", () => {
    expect(deriveIssue("2026-07-01T10:00:00.000Z")).toBe("013"); // Wed → coming Sat Jul 4
  });
  it("uses UTC, not local time (late-UTC Friday still resolves to that week's Saturday)", () => {
    expect(deriveIssue("2026-07-03T23:30:00.000Z")).toBe("013"); // Friday in UTC
  });
  it("returns null for an unparseable date", () => {
    expect(deriveIssue("not-a-date")).toBeNull();
  });
});

describe("verdicts export — toRow", () => {
  it("derives issue, defaults igUrl to null, imdbId null when the entry has none", () => {
    const r = toRow({ runAt: "2026-07-03T22:00:00.000Z", title: "Alpha", criticCount: 4, tbsiScore: 4, star: 2, verdict: "Skip", confidence: "high" });
    expect(r.issue).toBe("013");
    expect(r.igUrl).toBeNull();
    expect(r.imdbId).toBeNull();
  });
});

describe("verdicts export — mergeVerdicts", () => {
  const row = (o: Partial<VerdictRow>): VerdictRow => ({ imdbId: "tt1", title: "A", star: 2, tbsiScore: 4, verdict: "Skip", confidence: "high", criticCount: 4, runAt: "2026-07-04T00:00:00.000Z", issue: "013", igUrl: null, ...o });
  it("fresh data wins but preserves the existing igUrl", () => {
    const existing = [row({ verdict: "Skip", star: 2, igUrl: "https://instagram.com/p/abc" })];
    const fresh = [row({ verdict: "Worth a Try", star: 3, igUrl: null })];
    const merged = mergeVerdicts(existing, fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.verdict).toBe("Worth a Try");
    expect(merged[0]!.star).toBe(3);
    expect(merged[0]!.igUrl).toBe("https://instagram.com/p/abc"); // preserved from existing
  });
  it("existing manual rows absent from the fresh set survive", () => {
    const existing = [row({ imdbId: "tt-manual", title: "Manual", igUrl: "https://instagram.com/p/xyz" })];
    const fresh = [row({ imdbId: "tt1", title: "Fresh" })];
    const merged = mergeVerdicts(existing, fresh);
    expect(merged.map((r) => r.imdbId).sort()).toEqual(["tt-manual", "tt1"]);
    expect(merged.find((r) => r.imdbId === "tt-manual")!.igUrl).toBe("https://instagram.com/p/xyz");
  });
});

describe("verdicts server reader — safeReadVerdicts", () => {
  it("missing/invalid file → the empty shape (never throws)", () => {
    expect(safeReadVerdicts("/no/such/verdicts-does-not-exist.json")).toEqual({ updatedAt: null, verdicts: [] });
  });
});
