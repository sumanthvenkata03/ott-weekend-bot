// scripts/machine-room/summary.ts
// WHAT ACTUALLY HAPPENED — read from ARTIFACTS, never inferred from exit code.
//
// THE RULE THIS ENCODES (recon §1). Wednesday exits 0 on at least four
// outcomes that are NOT a publication:
//   • gate BLOCKED            → `return` after writeReview
//   • contract DOWNGRADE      → `return` after the red ping
//   • render audit RED        → `return` before R2
//   • an edition with 0 films → `return`, deliberately not a failure
// Plus the ordinary success. A UI that colours a run green on `exitCode === 0`
// is therefore lying four times out of five. So the summary is built from the
// receipts the run left on disk, and the verdict line says so out loud.
//
// The three receipts, all already written by the jobs themselves:
//   output/manifests/*-<date>.json      the landing + contract manifest
//   output/runs/*-<date>-results.json   the reconciled tier data
//   output/posts/*<date>*.png           the rendered cards
//
// PURE-ISH: every path is injectable, so the tests run against fixture
// directories and never touch the real output/ tree.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANIFESTS_DIR, POSTS_DIR, RUNS_DIR } from "./paths.js";

export interface ManifestFacts {
  file: string;
  pillar: string;
  issue: string;
  pass: number;
  warn: number;
  fail: number;
  ok: boolean;
  headSha?: string;
  treeDirty?: boolean | null;
  /** Written since the run started ⇒ THIS run produced it. See `sinceMs`. */
  fresh: boolean;
}

export interface ResultsFacts {
  file: string;
  pillar: string;
  total: number;
  green: number;
  yellow: number;
  red: number;
  addedByAiNet: number;
  /** Written since the run started ⇒ THIS run produced it. See `sinceMs`. */
  fresh: boolean;
}

export interface RunSummary {
  date: string;
  manifests: ManifestFacts[];
  results: ResultsFacts[];
  pngCount: number;
  /** Of pngCount, how many were written since the run started. */
  freshPngCount: number;
  /** Did THIS run produce any artifact at all? */
  producedAnything: boolean;
  /** True only when a manifest exists AND cards were rendered AND nothing failed. */
  looksPublished: boolean;
  /** The honest headline. */
  verdict: string;
  notes: string[];
}

export interface SummaryPaths {
  manifests?: string;
  runs?: string;
  posts?: string;
  /**
   * Epoch ms the run STARTED. Artifacts modified at or after it were produced by
   * THIS run; older ones merely share the date.
   *
   * Why this exists: the first live exercise ran a fake child that produced
   * nothing, and the summary reported "manifests=2, pngs=1" — true for the date,
   * badly misleading about the run. Date-scoping answers "what exists today";
   * only freshness answers "what did I just cause". Omit it and everything is
   * reported as fresh, which is the honest default when the caller cannot say.
   */
  sinceMs?: number;
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

interface RawManifest {
  pillar?: string;
  issue?: string;
  passCount?: number;
  warnCount?: number;
  failCount?: number;
  ok?: boolean;
  headSha?: string;
  treeDirty?: boolean | null;
}

interface RawResult {
  pillar?: string;
  counts?: { total?: number; green?: number; yellow?: number; red?: number; addedByAiNet?: number };
}

/**
 * Collect every receipt carrying `date` in its filename.
 *
 * Matching on the date SUFFIX rather than a glob is deliberate: manifests
 * accumulate across every run ever made, and `wed-drop-ott-2026-07-30.json`
 * must not be picked up by a query for 2026-07-03.
 */
export function buildSummary(date: string, paths: SummaryPaths = {}): RunSummary {
  const manifestsDir = paths.manifests ?? MANIFESTS_DIR;
  const runsDir = paths.runs ?? RUNS_DIR;
  const postsDir = paths.posts ?? POSTS_DIR;
  const sinceMs = paths.sinceMs;

  /**
   * Written at/after the run start? No `sinceMs` ⇒ everything counts as fresh.
   *
   * THE TOLERANCE IS NOT COSMETIC. Filesystem mtime granularity is coarser than
   * Date.now() — on NTFS a file written milliseconds AFTER the run started can
   * report an mtime fractionally BEFORE it. Compared strictly, that misfiles a
   * genuinely new artifact as "earlier", and the summary then announces
   * "THIS RUN PRODUCED NO ARTIFACTS" for a run that in fact published. Caught by
   * these tests failing ~1 run in 3.
   *
   * The two errors are not symmetric, so the tolerance leans deliberately:
   *   • too strict → a real publication is reported as producing nothing (bad:
   *     the operator disbelieves a correct deck, or re-runs and double-spends)
   *   • too loose  → an artifact from the preceding few seconds is attributed
   *     to this run (harmless: jobs take minutes, so nothing else is writing)
   */
  const FRESHNESS_TOLERANCE_MS = 2000;
  const floor = sinceMs === undefined ? 0 : sinceMs - FRESHNESS_TOLERANCE_MS;
  const isFresh = (dir: string, file: string): boolean => {
    if (sinceMs === undefined) return true;
    try {
      return statSync(join(dir, file)).mtimeMs >= floor;
    } catch {
      return false;
    }
  };

  const manifests: ManifestFacts[] = [];
  for (const f of listFiles(manifestsDir)) {
    if (!f.endsWith(`-${date}.json`)) continue;
    const m = readJson<RawManifest>(join(manifestsDir, f));
    if (!m) continue;
    manifests.push({
      file: f,
      pillar: m.pillar ?? "?",
      issue: m.issue ?? "?",
      pass: m.passCount ?? 0,
      warn: m.warnCount ?? 0,
      fail: m.failCount ?? 0,
      ok: m.ok === true,
      fresh: isFresh(manifestsDir, f),
      ...(m.headSha !== undefined ? { headSha: m.headSha } : {}),
      ...(m.treeDirty !== undefined ? { treeDirty: m.treeDirty } : {}),
    });
  }

  const results: ResultsFacts[] = [];
  for (const f of listFiles(runsDir)) {
    if (!f.endsWith(`-${date}-results.json`)) continue;
    const parsed = readJson<RawResult[]>(join(runsDir, f));
    if (!Array.isArray(parsed)) continue;
    const fresh = isFresh(runsDir, f);
    for (const r of parsed) {
      results.push({
        file: f,
        pillar: r.pillar ?? "?",
        total: r.counts?.total ?? 0,
        green: r.counts?.green ?? 0,
        yellow: r.counts?.yellow ?? 0,
        red: r.counts?.red ?? 0,
        addedByAiNet: r.counts?.addedByAiNet ?? 0,
        fresh,
      });
    }
  }

  const pngs = listFiles(postsDir).filter((f) => f.includes(date) && f.endsWith(".png"));
  const pngCount = pngs.length;
  const freshPngCount = pngs.filter((f) => isFresh(postsDir, f)).length;

  const notes: string[] = [];
  const anyFail = manifests.some((m) => !m.ok);
  const looksPublished = manifests.length > 0 && pngCount > 0 && !anyFail;
  const producedAnything =
    manifests.some((m) => m.fresh) || results.some((r) => r.fresh) || freshPngCount > 0;

  // A run that produced NOTHING must not be described by artifacts it merely
  // coexists with. This is the case the first live exercise got wrong.
  if (sinceMs !== undefined && !producedAnything) {
    return {
      date,
      manifests,
      results,
      pngCount,
      freshPngCount,
      producedAnything,
      looksPublished: false,
      verdict:
        "THIS RUN PRODUCED NO ARTIFACTS — it wrote no manifest, no reconcile results and no cards. " +
        (manifests.length > 0 || pngCount > 0
          ? "The receipts listed below are from EARLIER runs on the same date."
          : ""),
      notes: ["exit 0 ≠ published — read the artifacts.", "Freshness is by file mtime against the run's start time."],
    };
  }

  let verdict: string;
  if (manifests.length === 0 && results.length > 0) {
    verdict = "RECONCILED BUT NOT PUBLISHED — reconcile results exist, no manifest was written. The gate almost certainly blocked; read the review.";
    notes.push("A blocked gate exits 0. Exit code alone cannot tell you this.");
  } else if (manifests.length === 0 && results.length === 0) {
    verdict = "NO ARTIFACTS for this date — the run stopped before it produced anything, or this job writes none.";
  } else if (manifests.length > 0 && pngCount === 0) {
    verdict = "MANIFEST BUT NO CARDS — the contract or the render audit withheld delivery, or the run used --no-deliver.";
    notes.push("Checkpoint 2 (completeness contract) and checkpoint 3 (render audit) both return without rendering or delivering, and both exit 0.");
  } else if (anyFail) {
    verdict = "CARDS RENDERED BUT A MANIFEST FAILED — do not post without reading the failing rows.";
  } else {
    verdict = `${pngCount} card(s) rendered with a clean manifest — this looks like a real publication.`;
  }

  notes.push("exit 0 ≠ published — read the artifacts.");

  return { date, manifests, results, pngCount, freshPngCount, producedAnything, looksPublished, verdict, notes };
}
