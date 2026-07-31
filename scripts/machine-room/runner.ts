// scripts/machine-room/runner.ts
// SPAWN, STREAM, AND ACCOUNT FOR ONE RUN.
//
// Order of operations is the safety story, and it is deliberate:
//   1. take the publish lock   — refuse immediately if another run holds it
//   2. run preflight           — any RED aborts and RELEASES the lock
//   3. spawn                   — only now is anything spent
//   4. on exit, build the summary from ARTIFACTS, not the exit code
//   5. release the lock in a finally, always
//
// Preflight runs INSIDE the lock, not before it: two operators clicking at once
// must not both pass preflight and then race for the lock. Holding it first
// makes the second click a clean refusal.
//
// SPAWN SHAPE (Windows). `npx tsx <entry>` through the shell, cwd = repo root.
//   - shell:true because npx/tsx are .cmd shims on Windows; this is the same
//     precedent content/claude.ts already relies on.
//   - cwd = REPO_ROOT explicitly, never inherited. A job launched from the wrong
//     directory is what put `claude` in front of a workspace-trust dialog.
//   - TBSI_LOG_FILE is injected so every run leaves a durable, ANSI-stripped,
//     REDACTED tee on disk. Recon confirmed the variable is global to the logger
//     and set by nothing in the repo; M0 made it safe to point at a file.
//
// Nothing operator-supplied is ever interpolated into the command line — the
// entry and flags come from the frozen registry in jobs.ts.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { editorialTodayStamp } from "../../src/shared/editorial-clock.js";
import { JOBS, buildCommand, type JobId, type JobSpec } from "./jobs.js";
import { PUBLISH_LOCK, acquireLock, releaseLock, type LockHolder } from "./lock.js";
import { MR_RUN_LOGS, REPO_ROOT, runLogRelPath } from "./paths.js";
import { killTree } from "./proc.js";
import { createRedactingLineSplitter, sseFrame } from "./stream.js";
import { buildSummary, type RunSummary } from "./summary.js";
import type { PreflightReport } from "./preflight.js";

export interface RunLine {
  n: number;
  text: string;
}

export type RunStatus = "running" | "finished" | "aborted";

export interface RunRecord {
  runId: string;
  job: JobId;
  label: string;
  display: string;
  mode: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  status: RunStatus;
  logFile: string;
  lines: RunLine[];
  preflight?: PreflightReport;
  summary?: RunSummary;
  /** Set when the run never started (preflight RED or lock held). */
  abortReason?: string;
}

/** Bound the in-memory backlog so a chatty job cannot exhaust RAM. */
const MAX_BUFFERED_LINES = 5000;

type Subscriber = (frame: string) => void;

const runs = new Map<string, RunRecord>();
const subscribers = new Map<string, Set<Subscriber>>();
const children = new Map<string, ChildProcess>();

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
}

export function getRun(runId: string): RunRecord | undefined {
  return runs.get(runId);
}

export function recentRuns(limit = 10): RunRecord[] {
  return [...runs.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({ ...r, lines: [] }));
}

export function activeRunId(): string | null {
  for (const [id, r] of runs) if (r.status === "running") return id;
  return null;
}

export function subscribe(runId: string, fn: Subscriber): () => void {
  let set = subscribers.get(runId);
  if (!set) {
    set = new Set();
    subscribers.set(runId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) subscribers.delete(runId);
  };
}

function broadcast(runId: string, frame: string): void {
  const set = subscribers.get(runId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(frame);
    } catch {
      /* a dead client must not break the run */
    }
  }
}

function appendLine(rec: RunRecord, text: string): void {
  const n = rec.lines.length === 0 ? 1 : rec.lines[rec.lines.length - 1]!.n + 1;
  rec.lines.push({ n, text });
  if (rec.lines.length > MAX_BUFFERED_LINES) rec.lines.shift();
  broadcast(rec.runId, sseFrame("line", { n, text }));
}

export interface StartOptions {
  job: JobId;
  /** Typed confirmation for a job with no dry-run mode. */
  liveConfirm?: string;
  /**
   * Injected so preflight can be faked in tests. Receives the pid that ALREADY
   * holds the lock on this run's behalf, so the lock check can recognise itself
   * instead of REDing on the file it just wrote (the M1.1 self-deadlock).
   */
  preflight: (selfHolderPid: number) => Promise<PreflightReport>;
  /** Test seam: an alternative spec (the fake child). */
  specOverride?: JobSpec;
}

export type StartOutcome =
  | { ok: true; runId: string; record: RunRecord }
  | { ok: false; code: "locked"; holder: LockHolder; reason: string }
  | { ok: false; code: "preflight"; report: PreflightReport }
  | { ok: false; code: "confirm"; reason: string };

/**
 * Take the lock, preflight, spawn. Resolves as soon as the child is RUNNING —
 * the caller streams the rest over SSE.
 */
export async function startRun(opts: StartOptions): Promise<StartOutcome> {
  const spec = opts.specOverride ?? JOBS[opts.job];

  if (spec.requiresLiveConfirm && opts.liveConfirm !== "LIVE") {
    return {
      ok: false,
      code: "confirm",
      reason: `${spec.label} has no dry-run mode — it will ${spec.willSend}. Type LIVE to confirm.`,
    };
  }

  const { command, args, display } = buildCommand(spec);

  const lock = acquireLock(PUBLISH_LOCK, { jobName: spec.label, argv: [command, ...args] });
  if (!lock.ok) return { ok: false, code: "locked", holder: lock.holder, reason: lock.reason };

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock(PUBLISH_LOCK);
  };

  try {
    // Pass our own holder identity: we took the lock two lines ago, so a lock
    // check that does not know that would refuse the run it is checking for.
    const report = await opts.preflight(lock.holder.pid);
    if (!report.ok) {
      release();
      return { ok: false, code: "preflight", report };
    }

    const runId = newRunId();
    mkdirSync(MR_RUN_LOGS, { recursive: true });
    const logFile = runLogRelPath(runId);

    // Captured BEFORE the spawn: everything written at/after this instant is
    // attributable to THIS run, so the summary can say what the run produced
    // rather than merely what shares its date.
    const startedMs = Date.now();

    const rec: RunRecord = {
      runId,
      job: spec.id,
      label: spec.label,
      display,
      mode: spec.mode,
      startedAt: new Date().toISOString(),
      status: "running",
      logFile,
      lines: [],
      preflight: report,
    };
    runs.set(runId, rec);

    if (lock.tookOver) {
      appendLine(rec, `⚠ took over a STALE publish lock left by dead pid ${lock.tookOver.pid} (${lock.tookOver.jobName})`);
    }
    appendLine(rec, `▶ ${display}`);
    appendLine(rec, `   cwd=${REPO_ROOT}`);
    appendLine(rec, `   mode=${spec.mode} · forced flags: ${spec.flags.length ? spec.flags.join(" ") : "(none)"}`);
    appendLine(rec, `   tee → ${logFile}`);

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      shell: true,
      env: { ...process.env, TBSI_LOG_FILE: logFile },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(runId, child);

    const splitter = createRedactingLineSplitter((line) => appendLine(rec, line));
    child.stdout?.on("data", (c) => splitter.push(c));
    child.stderr?.on("data", (c) => splitter.push(c));

    const finish = (exitCode: number | null, note?: string) => {
      if (rec.status !== "running") return;
      splitter.flush();
      if (note) appendLine(rec, note);
      rec.status = "finished";
      rec.exitCode = exitCode;
      rec.endedAt = new Date().toISOString();
      rec.summary = buildSummary(editorialTodayStamp(), { sinceMs: startedMs });
      children.delete(runId);
      release();
      appendLine(rec, `■ exited ${exitCode ?? "?"} — ${rec.summary.verdict}`);
      broadcast(runId, sseFrame("exit", {
        exitCode,
        endedAt: rec.endedAt,
        summary: rec.summary,
      }));
    };

    child.on("error", (e) => finish(null, `✗ could not start: ${e.message}`));
    child.on("close", (code) => finish(code));

    return { ok: true, runId, record: rec };
  } catch (e) {
    release();
    throw e;
  }
}

/**
 * Kill every live child. Called from the server's SIGTERM/SIGINT handlers.
 *
 * killTree, NOT child.kill: these children are spawned with shell:true, so the
 * handle is the cmd.exe shim and signalling it orphans the real node process —
 * which would keep running the job, keep spending, and keep holding the lock's
 * assumptions false. See proc.ts.
 */
export function killAll(signal: NodeJS.Signals = "SIGTERM"): number {
  let n = 0;
  for (const [runId, child] of children) {
    try {
      killTree(child.pid, signal);
      n++;
    } catch {
      /* already gone */
    }
    const rec = runs.get(runId);
    if (rec && rec.status === "running") {
      rec.status = "aborted";
      rec.abortReason = "machine room shut down";
      rec.endedAt = new Date().toISOString();
    }
  }
  children.clear();
  releaseLock(PUBLISH_LOCK);
  return n;
}

/**
 * Is `pid` a live child THIS server spawned, or this server itself while it
 * still tracks a running child? Break Lock refuses in both cases: the lock is
 * doing its job, and forcing it would let a second run start alongside a real
 * one — the exact collision the lock exists to prevent.
 */
export function isOwnLiveHolder(pid: number): boolean {
  if (pid === process.pid && activeRunId() !== null) return true;
  for (const [runId, child] of children) {
    if (child.pid === pid) {
      const rec = runs.get(runId);
      if (rec && rec.status === "running") return true;
    }
  }
  return false;
}

/** Test seam — drop all in-memory run state. */
export function __resetRuns(): void {
  runs.clear();
  subscribers.clear();
  children.clear();
}
