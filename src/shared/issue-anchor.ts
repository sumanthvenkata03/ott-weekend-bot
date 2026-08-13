// src/shared/issue-anchor.ts
// WD-ENG-02 — THE ISSUE NUMBER BELONGS TO THE EDITION, NOT TO THE CLOCK.
//
// ── THE CATASTROPHE ─────────────────────────────────────────────────────────
// Wed Drop is a TWO-PHASE run. Phase 1 discovers, reconciles and emits an
// approve hash, then STOPS. Phase 2 (`--approve <hash>`) re-runs the whole
// pipeline, matches the hash, and renders. Both phases called
// getIssueNumberForToday() independently.
//
// Issue 042's gate was created before IST midnight and approved after it. The
// two phases therefore computed DIFFERENT issue numbers from the same edition.
// The ledger held the deck's films under the phase-1 number; the render phase
// asked excludedKeysFor({ excludeIssue: <phase-2 number> }); the self-exemption
// that exists precisely so an edition cannot dedup itself did not match — and
// the deck excluded its own films.
//
// Wall-clock numbering is correct for a SINGLE-PHASE pillar (Mon, Sat, Sun all
// compute and publish in one process). It is wrong for the only pillar whose
// decision and its execution are separated by an operator, a review, and
// potentially a night's sleep. The number must be decided ONCE, when the deck
// is decided, and then carried.
//
// ── WHY THE ANCHOR IS KEYED BY HASH ─────────────────────────────────────────
// The obvious home for the anchor is the run artifact — but every run artifact
// is named with editorialTodayStamp(), which is the very value that changes
// across midnight. Phase 2 would look for a file whose name it can no longer
// derive. The hash is the ONLY identifier both phases provably share: the
// operator types it, decideGate recomputes it from the reconciled deck, and it
// is stable by construction (that is what --approve binds to). So the anchor
// lives at a hash-keyed path, and phase 2 finds it by the token in its own argv.
//
// ── HASH NEUTRALITY ─────────────────────────────────────────────────────────
// The anchor is a SEPARATE file. computeDropHash hashes film fingerprints and
// nothing else, so writing this cannot perturb it — the separation makes that
// structural rather than a promise, and it is pinned by test.

import { existsSync, readFileSync } from "node:fs";
import { editorialDateUTC, utcStamp } from "./editorial-clock.js";
import { getIssueNumber } from "./issue-number.js";
import { log } from "./logger.js";
import { saveRunArtifact, RUN_LOG_DIR } from "./run-artifacts.js";

/** Per-edition discovery windows, recorded so the anchor is self-describing. */
export type IssueAnchorWindows = Record<string, { start: string; end: string }>;

export interface IssueAnchor {
  /** The approve hash this anchor belongs to. Also its filename key. */
  hash: string;
  /** The issue number the EDITION owns, decided once at gate creation. */
  issueNumber: string;
  windows: IssueAnchorWindows;
  /** Instant the anchor was created (UTC ISO). */
  anchoredAt: string;
  /** IST calendar date the issue number was computed from. */
  anchoredDate: string;
}

/**
 * Where the anchor for `hash` lives. Beside the run JSONs and the run log, so
 * one directory holds everything one run produced.
 */
export function issueAnchorPath(hash: string, dir: string = RUN_LOG_DIR): string {
  return `${dir}/wed-drop-gate-${hash}-anchor.json`;
}

/** The anchor for `hash`, or null when absent/unreadable. Never throws. */
export function readIssueAnchor(hash: string, dir: string = RUN_LOG_DIR): IssueAnchor | null {
  const path = issueAnchorPath(hash, dir);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<IssueAnchor>;
    // A file that exists but carries no number is the same situation as no file
    // at all — the caller must take the loud fallback, never a silent undefined.
    if (typeof parsed.issueNumber !== "string" || parsed.issueNumber.length === 0) return null;
    return parsed as IssueAnchor;
  } catch {
    return null;
  }
}

/** How `resolveIssueNumber` arrived at its answer. Reported, never inferred. */
export type IssueNumberSource =
  /** Read from an existing anchor — the edition's own number. */
  | "anchored"
  /** No anchor yet: this run IS the gate creation. Computed and persisted. */
  | "created"
  /** An --approve run found no anchor (pre-WD-ENG-02 artifact). Loud fallback. */
  | "wall-clock-fallback";

export interface ResolvedIssueNumber {
  issueNumber: string;
  source: IssueNumberSource;
}

/**
 * THE ONE SEAM. Returns the issue number this run must use everywhere.
 *
 *   anchor exists            → use it (phase 2, and every re-approve)
 *   no anchor, not approving → this run is gate creation: compute + PERSIST
 *   no anchor, approving     → backward compatibility. LOUD warn, wall clock.
 *
 * `isApprove` is what separates "establishing the anchor" from "the anchor
 * should have been there". A fresh gate run creating its anchor is normal and
 * silent; an --approve run that cannot find one is a divergence risk and says so
 * every single time.
 *
 * THE FALLBACK DELIBERATELY DOES NOT PERSIST. Writing an anchor we already know
 * was derived from the wrong clock would silence the warning on every subsequent
 * re-approve and stamp a suspect number as authoritative. The requirement is
 * "never a silent divergence", so the noise repeats until the operator re-gates.
 */
export function resolveIssueNumber(opts: {
  hash: string;
  isApprove: boolean;
  windows: IssueAnchorWindows;
  now?: Date;
  dir?: string;
}): ResolvedIssueNumber {
  const { hash, isApprove, windows } = opts;
  const dir = opts.dir ?? RUN_LOG_DIR;
  const now = opts.now ?? new Date();

  const existing = readIssueAnchor(hash, dir);
  if (existing) {
    log.info(
      `  Issue anchor: №${existing.issueNumber} (anchored ${existing.anchoredDate} to gate ${hash})`
    );
    return { issueNumber: existing.issueNumber, source: "anchored" };
  }

  const editorialDate = editorialDateUTC(now);
  const issueNumber = getIssueNumber(editorialDate);

  if (isApprove) {
    log.warn(
      `  ⚠ issue anchor missing — falling back to wall-clock №${issueNumber} ` +
      `(gate ${hash} predates the issue anchor; if this approval crossed IST midnight the ` +
      `ledger self-exemption will not match and the deck may dedup itself)`
    );
    return { issueNumber, source: "wall-clock-fallback" };
  }

  const anchor: IssueAnchor = {
    hash,
    issueNumber,
    windows,
    anchoredAt: now.toISOString(),
    anchoredDate: utcStamp(editorialDate),
  };
  saveRunArtifact(issueAnchorPath(hash, dir), anchor);
  log.info(`  Issue anchor: №${issueNumber} pinned to gate ${hash} (${anchor.anchoredDate})`);
  return { issueNumber, source: "created" };
}
