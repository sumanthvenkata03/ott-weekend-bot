// scripts/machine-room/paths.ts
// Absolute anchors. Everything the machine room touches is resolved from the
// REPO ROOT, never from process.cwd() — a job spawned with the wrong cwd is
// exactly the class of failure that cost a 3-minute generation to the claude
// workspace-trust dialog.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** scripts/machine-room/ */
export const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo root — two levels up from scripts/machine-room/. */
export const REPO_ROOT = join(HERE, "..", "..");

/** Where jobs write their receipts. */
export const OUTPUT_DIR = join(REPO_ROOT, "output");
export const MANIFESTS_DIR = join(OUTPUT_DIR, "manifests");
export const RUNS_DIR = join(OUTPUT_DIR, "runs");
export const POSTS_DIR = join(OUTPUT_DIR, "posts");

/** Machine-room state. Under data/, which is already gitignored. */
export const MR_DIR = join(REPO_ROOT, "data", "machine-room");
export const MR_RUN_LOGS = join(MR_DIR, "runs");

/**
 * TBSI_LOG_FILE is resolved by the CHILD against its own cwd (the repo root),
 * so the value handed to it must stay repo-relative with forward slashes.
 */
export function runLogRelPath(runId: string): string {
  return `data/machine-room/runs/${runId}.log`;
}
