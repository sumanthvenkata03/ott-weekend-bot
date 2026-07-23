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
import { log } from "./logger.js";

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
