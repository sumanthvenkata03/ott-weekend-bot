// src/shared/run-artifacts.ts
// REPAIRABLE REDS. A blocked or downgraded run must be diagnosable — and
// fixable — WITHOUT re-running the LLM.
//
// Before this, a Wednesday RED left only PNGs and a manifest. The draft (the
// LLM's slides and picks) and the reconciled results (tiers, provenance,
// enforcement verdicts) existed only in memory, so the single question a red
// ping provokes — "what exactly did it decide, and why?" — cost a full,
// billed re-run to answer.
//
// Artifacts are written BEFORE any checkpoint, so they survive every outcome:
// auto-publish, downgrade, block, or crash. Writing is best-effort and never
// throws; losing a debug artifact must not lose a good deck.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log, __resetLogTee } from "./logger.js";

/**
 * Persist one run artifact as pretty JSON. Never throws.
 * Returns the path on success, "" on failure.
 */
export function saveRunArtifact(path: string, value: unknown): string {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
    return path;
  } catch (err) {
    log.warn(`  Could not persist run artifact ${path}`, err instanceof Error ? err.message : err);
    return "";
  }
}

/** Conventional artifact path: output/runs/<slug>-<date>-<kind>.json */
export function runArtifactPath(slug: string, date: string, kind: string): string {
  return `output/runs/${slug}-${date}-${kind}.json`;
}

// ── WD-ENG-01 PART 4 — THE RUN LOG ──────────────────────────────────────────
//
// The draft and the results already survive a run (that is what this module is
// for). The REASONING did not: it went to stdout, and stdout was a terminal
// window. Three incidents in one week were partially unrecoverable because of
// it — most sharply Issue 042, where the copy guard's strike-1 warn line named
// the offender that ultimately cost Aroopi its slot, and that line existed
// nowhere by the time anyone asked.
//
// The tee itself already exists (shared/logger.ts, TBSI_LOG_FILE). It was
// OPT-IN, which means it was off exactly when it mattered. This makes it
// unconditional at the job entry points: no env var to remember, no flag to
// pass, one file per run, next to the run JSONs it explains.
//
// An explicit TBSI_LOG_FILE still wins — an operator pointing the tee somewhere
// deliberately is not overridden by a default.

/** Filesystem-safe instant: 2026-08-13T03-36-07-684Z. */
function runStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Where run logs live. Same directory runArtifactPath writes its JSONs to. */
export const RUN_LOG_DIR = "output/runs";

/**
 * Begin persisting this run's log to `<dir>/<slug>-<stamp>.log`, beside the run
 * JSONs. Never throws: the tee itself already fails quiet (a broken log sink
 * must not take down a publishing run), and an unwritable path costs a warning,
 * not the deck.
 *
 * `dir` is a parameter ONLY so tests can point it at a scratch directory. Every
 * production call site takes the default. It exists because the alternative —
 * a test that process.chdir()s to relocate the relative default — mutates state
 * shared by every other test file in the same vitest worker, and produced
 * exactly one catastrophic cross-file failure before being removed.
 *
 * Returns the resolved path.
 */
export function startRunLog(slug: string, now: Date = new Date(), dir: string = RUN_LOG_DIR): string {
  const explicit = process.env.TBSI_LOG_FILE?.trim();
  if (explicit) {
    log.info(`  Run log: ${explicit} (TBSI_LOG_FILE — operator override)`);
    return explicit;
  }
  const path = `${dir}/${slug}-${runStamp(now)}.log`;
  process.env.TBSI_LOG_FILE = path;
  // The tee memoises its resolved path; clear it so this run's file is picked up
  // even if an earlier value was already cached in-process.
  __resetLogTee();
  log.info(`  Run log: ${path}`);
  return path;
}
