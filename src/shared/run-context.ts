// src/shared/run-context.ts
// WHAT CODE IS ACTUALLY RUNNING — and may it publish?
//
// THE WORKING-TREE LAW. Every job runs through `tsx` against the WORKING TREE,
// not a build artifact. There is no compile step between an edit and a
// publication. So an uncommitted experiment left on a Tuesday night silently
// becomes Wednesday's published behaviour, and the commit history is not a
// record of what shipped.
//
// Two consequences, both implemented here:
//   1. Every manifest records the HEAD sha AND whether the tree was dirty, so a
//      published deck can always be traced to code.
//   2. A SCHEDULED run refuses to start on a dirty tree. "Commit before run"
//      becomes "commit before EVERY scheduled run", enforced rather than
//      remembered.
//
// FAILS CLOSED, in the direction that matters: if the tree is dirty we refuse.
// But if git itself is unavailable we ALSO refuse for a scheduled run — an
// unknown tree state is not a clean one. A MANUAL run is never blocked; the
// operator is present and owns the call.

import { execFileSync } from "node:child_process";

/** Env flag a scheduler sets. Manual runs leave it unset and are unaffected. */
export const SCHEDULED_ENV = "TBSI_SCHEDULED";

export interface RunContext {
  /** Short HEAD sha, or "" when git could not be read. */
  headSha: string;
  /** true/false when known; null when git could not be read. */
  dirty: boolean | null;
  /** Was this run launched by the scheduler? */
  scheduled: boolean;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** True when the scheduler launched this run (TBSI_SCHEDULED=1/true). */
export function isScheduledRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes"].includes((env[SCHEDULED_ENV] ?? "").trim().toLowerCase());
}

/** Read the current run context. Never throws. */
export function readRunContext(env: NodeJS.ProcessEnv = process.env): RunContext {
  const sha = git(["rev-parse", "--short", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  return {
    headSha: sha ?? "",
    dirty: status === null ? null : status.length > 0,
    scheduled: isScheduledRun(env),
  };
}

/**
 * PURE decision half, so the rule is testable without a repo: may this run
 * proceed to publish? Manual ⇒ always. Scheduled ⇒ only on a known-clean tree.
 */
export function scheduledRunBlockReason(ctx: RunContext): string | null {
  if (!ctx.scheduled) return null;
  if (ctx.dirty === null) {
    return (
      "scheduled run refused — could not read git state, so the working tree cannot be " +
      "proven clean. An unknown tree is not a clean tree."
    );
  }
  if (ctx.dirty) {
    return (
      "scheduled run refused — working tree is DIRTY. Jobs execute the working tree, " +
      "so uncommitted changes would publish unreviewed. Commit (or stash) first."
    );
  }
  return null;
}

/**
 * Enforce the law. Throws on a scheduled dirty/unknown tree; returns the context
 * otherwise. Call this BEFORE any spend (LLM, render, upload).
 */
export function assertPublishableTree(env: NodeJS.ProcessEnv = process.env): RunContext {
  const ctx = readRunContext(env);
  const reason = scheduledRunBlockReason(ctx);
  if (reason) throw new Error(reason);
  return ctx;
}

/** One-line provenance stamp for logs and the Slack package. */
export function provenanceLine(ctx: RunContext): string {
  const sha = ctx.headSha || "unknown";
  const tree = ctx.dirty === null ? "tree unknown" : ctx.dirty ? "tree DIRTY" : "tree clean";
  return `${sha} · ${tree}${ctx.scheduled ? " · scheduled" : " · manual"}`;
}
