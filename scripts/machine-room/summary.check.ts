// scripts/machine-room/summary.check.ts
// EXIT 0 ≠ PUBLISHED.
//
// Wednesday returns cleanly on four non-publications — gate blocked, contract
// downgrade, render-audit RED, and an empty edition — plus the real success. A
// UI that colours a run green on exitCode 0 is therefore wrong four times out of
// five. These fixtures pin that the summary reads the ARTIFACTS instead.
//
// Every path is injected, so the real output/ tree is never read or written.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSummary, type SummaryPaths } from "./summary.js";

const DATE = "2026-07-30";
let root: string;
let paths: SummaryPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tbsi-summary-"));
  paths = {
    manifests: join(root, "manifests"),
    runs: join(root, "runs"),
    posts: join(root, "posts"),
  };
  for (const d of Object.values(paths)) mkdirSync(d as string, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function manifest(name: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    join(paths.manifests as string, name),
    JSON.stringify({
      pillar: "Wed Drop · In Theaters", issue: "032", builtAt: "x",
      headSha: "e3f322f", treeDirty: true,
      rows: [], passCount: 5, warnCount: 1, failCount: 0, ok: true, ...over,
    }),
    "utf8"
  );
}
function results(name: string, counts: Record<string, number>): void {
  writeFileSync(
    join(paths.runs as string, name),
    JSON.stringify([{ pillar: "theatrical", window: {}, reconciled: [], rejected: [], counts }]),
    "utf8"
  );
}
function png(name: string): void {
  writeFileSync(join(paths.posts as string, name), "not-really-a-png", "utf8");
}

describe("THE GATE-BLOCKED RUN — exit 0, nothing published", () => {
  it("is classified NOT published, and says why", () => {
    // A blocked gate writes the reconcile results and STOPS: no manifest, no PNGs.
    results(`wed-drop-${DATE}-results.json`, { total: 9, green: 4, yellow: 3, red: 2, addedByAiNet: 1 });

    const s = buildSummary(DATE, paths);
    expect(s.looksPublished).toBe(false);
    expect(s.verdict).toContain("NOT PUBLISHED");
    expect(s.verdict).toContain("gate");
    expect(s.manifests).toHaveLength(0);
    expect(s.results[0]).toMatchObject({ total: 9, green: 4, yellow: 3, red: 2 });
    expect(s.notes.join(" ")).toContain("exit 0");
  });
});

describe("the other exit-0 non-publications", () => {
  it("MANIFEST BUT NO CARDS — a contract downgrade or audit RED withheld delivery", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`);
    const s = buildSummary(DATE, paths);
    expect(s.looksPublished).toBe(false);
    expect(s.verdict).toContain("NO CARDS");
    expect(s.notes.join(" ")).toContain("render audit");
  });

  it("NO ARTIFACTS AT ALL — the run stopped before producing anything", () => {
    const s = buildSummary(DATE, paths);
    expect(s.looksPublished).toBe(false);
    expect(s.verdict).toContain("NO ARTIFACTS");
  });

  it("a FAILING manifest is called out even with cards on disk", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`, { failCount: 2, ok: false });
    png(`wed-drop-theatrical-${DATE}-cover.png`);
    const s = buildSummary(DATE, paths);
    expect(s.looksPublished).toBe(false);
    expect(s.verdict).toContain("MANIFEST FAILED");
  });
});

describe("the real publication", () => {
  it("manifest + cards + no failures reads as published", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`);
    results(`wed-drop-${DATE}-results.json`, { total: 6, green: 6, yellow: 0, red: 0, addedByAiNet: 0 });
    for (let i = 1; i <= 5; i++) png(`wed-drop-theatrical-${DATE}-card-0${i}.png`);
    png(`wed-drop-theatrical-${DATE}-cover.png`);

    const s = buildSummary(DATE, paths);
    expect(s.looksPublished).toBe(true);
    expect(s.pngCount).toBe(6);
    expect(s.verdict).toContain("real publication");
    expect(s.manifests[0]).toMatchObject({ pass: 5, warn: 1, fail: 0, ok: true, headSha: "e3f322f", treeDirty: true });
  });
});

describe("date scoping — yesterday's receipts never count as today's", () => {
  it("ignores artifacts from another date", () => {
    manifest("wed-drop-theatrical-2026-07-29.json");
    png("wed-drop-theatrical-2026-07-29-cover.png");
    results("wed-drop-2026-07-29-results.json", { total: 3, green: 3, yellow: 0, red: 0, addedByAiNet: 0 });

    const s = buildSummary(DATE, paths);
    expect(s.manifests).toHaveLength(0);
    expect(s.results).toHaveLength(0);
    expect(s.pngCount).toBe(0);
  });

  it("does not confuse a date PREFIX (07-03 must not match 07-30)", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`);
    const s = buildSummary("2026-07-03", paths);
    expect(s.manifests).toHaveLength(0);
  });

  it("collects BOTH editions for the same date", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`);
    manifest(`wed-drop-ott-${DATE}.json`, { pillar: "Wed Drop · Now Streaming" });
    expect(buildSummary(DATE, paths).manifests).toHaveLength(2);
  });
});

describe("FRESHNESS — what THIS run produced, not what shares its date", () => {
  it("tolerates coarse filesystem mtime granularity — a just-written artifact is FRESH", () => {
    // The regression: NTFS can report an mtime fractionally BEFORE the
    // Date.now() captured immediately prior, so a strict >= misfiled brand-new
    // artifacts as "earlier" and the summary claimed the run produced nothing.
    // Ran ~1-in-3 flaky before FRESHNESS_TOLERANCE_MS existed.
    for (let i = 0; i < 25; i++) {
      const since = Date.now();
      manifest(`wed-drop-theatrical-${DATE}.json`);
      const s = buildSummary(DATE, { ...paths, sinceMs: since });
      expect(s.manifests[0]!.fresh).toBe(true);
      expect(s.producedAnything).toBe(true);
    }
  });

  it("a run that produced nothing says so, even when the date has receipts", async () => {
    // The bug this pins: the first live exercise ran a child that produced
    // nothing, and the summary reported "manifests=2, pngs=1" — true for the
    // date, badly misleading about the run.
    manifest(`wed-drop-theatrical-${DATE}.json`);
    png(`wed-drop-theatrical-${DATE}-cover.png`);
    // Must clear FRESHNESS_TOLERANCE_MS (2s), or these genuinely-old artifacts
    // would be attributed to the run by the deliberate leniency in isFresh.
    await new Promise((r) => setTimeout(r, 2600));

    const s = buildSummary(DATE, { ...paths, sinceMs: Date.now() });
    expect(s.producedAnything).toBe(false);
    expect(s.looksPublished).toBe(false);
    expect(s.verdict).toContain("PRODUCED NO ARTIFACTS");
    expect(s.verdict).toContain("EARLIER runs");
    // The older receipts are still LISTED — hidden receipts would be worse.
    expect(s.manifests).toHaveLength(1);
    expect(s.manifests[0]!.fresh).toBe(false);
    expect(s.pngCount).toBe(1);
    expect(s.freshPngCount).toBe(0);
  });

  it("artifacts written after the start ARE attributed to the run", () => {
    const since = Date.now();
    manifest(`wed-drop-theatrical-${DATE}.json`);
    png(`wed-drop-theatrical-${DATE}-cover.png`);

    const s = buildSummary(DATE, { ...paths, sinceMs: since });
    expect(s.producedAnything).toBe(true);
    expect(s.manifests[0]!.fresh).toBe(true);
    expect(s.freshPngCount).toBe(1);
    expect(s.verdict).toContain("real publication");
  });

  it("omitting sinceMs keeps the date-scoped behaviour (everything counts as fresh)", () => {
    manifest(`wed-drop-theatrical-${DATE}.json`);
    const s = buildSummary(DATE, paths);
    expect(s.producedAnything).toBe(true);
    expect(s.manifests[0]!.fresh).toBe(true);
  });

  it("a gate-blocked run is still classified from its OWN fresh results", () => {
    const since = Date.now();
    results(`wed-drop-${DATE}-results.json`, { total: 9, green: 4, yellow: 3, red: 2, addedByAiNet: 1 });
    const s = buildSummary(DATE, { ...paths, sinceMs: since });
    expect(s.producedAnything).toBe(true);
    expect(s.verdict).toContain("NOT PUBLISHED");
  });
});

describe("robustness — a bad receipt must not take down the summary", () => {
  it("skips unparseable JSON rather than throwing", () => {
    writeFileSync(join(paths.manifests as string, `broken-${DATE}.json`), "{oops", "utf8");
    manifest(`wed-drop-theatrical-${DATE}.json`);
    expect(buildSummary(DATE, paths).manifests).toHaveLength(1);
  });

  it("survives missing directories entirely", () => {
    const s = buildSummary(DATE, { manifests: join(root, "nope"), runs: join(root, "nope"), posts: join(root, "nope") });
    expect(s.pngCount).toBe(0);
    expect(s.verdict).toContain("NO ARTIFACTS");
  });
});
