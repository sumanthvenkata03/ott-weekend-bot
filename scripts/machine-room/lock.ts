// scripts/machine-room/lock.ts
// THE PUBLISH LOCK — one job:* at a time, across processes.
//
// WHY (recon §5). Two concurrent runs corrupt three different things and cost
// real money doing it: cleanOldRenders globs by (slug, date) and deletes the
// other run's cards mid-upload; recordFeatured is a DELETE+INSERT keyed on
// (pillar, issue) and issue is a pure function of the date, so the loser's rows
// vanish; and cached() is read-then-write with no single-flight, so both runs
// miss and both pay ~34 Tavily credits and ~7 claude spawns.
//
// SCOPE IS GLOBAL, name "publish" — one job at a time, full stop. Per-issue
// locks are a later milestone; this is the coarse, obviously-correct version.
//
// ── PID LIVENESS ON WINDOWS ─────────────────────────────────────────────────
// The stale-takeover path is the dangerous one: if the liveness test were wrong
// in the "kills it" direction, checking a lock would terminate a running job.
// So this was verified empirically on this machine (Node v24, win32) rather
// than assumed from the docs:
//
//   process.kill(livePid, 0)  -> returns, child survives (exitCode null)
//   process.kill(deadPid, 0)  -> throws ESRCH
//   process.kill(999999,  0)  -> throws ESRCH
//
// Signal 0 is a pure existence probe on Windows too — libuv special-cases it
// rather than routing to TerminateProcess. EPERM is treated as ALIVE: the
// process exists, we merely lack rights to signal it (another user, or
// elevated). Treating EPERM as dead would be exactly the fatal misread.
//
// KNOWN RESIDUAL — PID REUSE. If the holder died and the OS recycled its pid
// onto an unrelated process, isAlive says "alive" and we refuse rather than
// take over. That fails SAFE (a spurious refusal, never a double-run) and the
// operator can delete the file. MAX_LOCK_AGE_MS is deliberately NOT used to
// auto-break a live-pid lock, because a legitimately long Wednesday run must
// never be stolen out from under itself.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.js";

/** data/ is already gitignored, so lock files never reach the repo. */
export const DEFAULT_LOCK_DIR = join(REPO_ROOT, "data", "locks");

/** The only lock name M1 uses. */
export const PUBLISH_LOCK = "publish";

export interface LockHolder {
  pid: number;
  startedAt: string;
  jobName: string;
  argv: string[];
}

export type AcquireOutcome =
  | { ok: true; holder: LockHolder; tookOver: LockHolder | null }
  | { ok: false; holder: LockHolder; reason: string };

export interface LockOptions {
  /** Override the lock directory (tests). */
  dir?: string;
  /** Override the liveness probe (tests). */
  isAlive?: (pid: number) => boolean;
  /** Override the clock (tests). */
  now?: () => Date;
}

export function lockPath(name: string, dir: string = DEFAULT_LOCK_DIR): string {
  return join(dir, `${name}.json`);
}

/**
 * Is this pid a running process? See the header for the empirical basis.
 * EPERM ⇒ alive-but-not-ours. Anything else (ESRCH, bad input) ⇒ dead.
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read the current holder, or null when absent/unreadable/corrupt. */
export function readLock(name: string, opts: LockOptions = {}): LockHolder | null {
  const path = lockPath(name, opts.dir ?? DEFAULT_LOCK_DIR);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LockHolder>;
    if (typeof raw.pid !== "number") return null;
    return {
      pid: raw.pid,
      startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      jobName: typeof raw.jobName === "string" ? raw.jobName : "",
      argv: Array.isArray(raw.argv) ? raw.argv.map(String) : [],
    };
  } catch {
    return null;
  }
}

function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/**
 * Take the lock, or report who holds it.
 *
 * Written with the `wx` flag so creation is atomic against another process
 * racing us — the filesystem, not a check-then-act, is the arbiter.
 *
 * A dead holder is taken over (with the displaced holder returned so the caller
 * can log it loudly). A corrupt/unreadable lock file is also taken over: it
 * cannot name a process to protect, and leaving it would wedge the server
 * permanently with no way out but manual deletion.
 */
export function acquireLock(
  name: string,
  info: { pid?: number; jobName: string; argv: string[] },
  opts: LockOptions = {}
): AcquireOutcome {
  const dir = opts.dir ?? DEFAULT_LOCK_DIR;
  const isAlive = opts.isAlive ?? pidIsAlive;
  const path = lockPath(name, dir);
  mkdirSync(dir, { recursive: true });

  const holder: LockHolder = {
    pid: info.pid ?? process.pid,
    startedAt: (opts.now?.() ?? new Date()).toISOString(),
    jobName: info.jobName,
    argv: info.argv,
  };
  const write = () =>
    writeFileSync(path, JSON.stringify(holder, null, 2), { encoding: "utf8", flag: "wx" });

  try {
    write();
    return { ok: true, holder, tookOver: null };
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
  }

  const existing = readLock(name, { dir });

  if (existing !== null && isAlive(existing.pid)) {
    const since = existing.startedAt || "unknown time";
    return {
      ok: false,
      holder: existing,
      reason:
        `"${name}" is held by a LIVE process — pid ${existing.pid} running ` +
        `${existing.jobName || "(unnamed)"} since ${since}. Wait for it, or stop it.`,
    };
  }

  // Dead or unreadable holder → take over.
  try {
    unlinkSync(path);
  } catch (e) {
    if (errCode(e) !== "ENOENT") throw e;
  }
  try {
    write();
  } catch (e) {
    if (errCode(e) !== "EEXIST") throw e;
    // Another process won the gap between unlink and write. Fail safe: refuse.
    const raced = readLock(name, { dir });
    return {
      ok: false,
      holder: raced ?? { pid: -1, startedAt: "", jobName: "", argv: [] },
      reason: `"${name}" was taken by another process while replacing a stale lock.`,
    };
  }
  return { ok: true, holder, tookOver: existing };
}

/**
 * Release the lock — ONLY if we hold it. A process must never delete another
 * process's lock: that is how a "cleanup" turns into two concurrent runs.
 */
export function releaseLock(
  name: string,
  pid: number = process.pid,
  opts: LockOptions = {}
): { released: boolean; reason: string } {
  const dir = opts.dir ?? DEFAULT_LOCK_DIR;
  const existing = readLock(name, { dir });
  if (existing === null) return { released: false, reason: "no lock file present" };
  if (existing.pid !== pid) {
    return {
      released: false,
      reason: `refusing to release a lock held by pid ${existing.pid} (this process is ${pid})`,
    };
  }
  try {
    unlinkSync(lockPath(name, dir));
    return { released: true, reason: "released" };
  } catch (e) {
    if (errCode(e) === "ENOENT") return { released: false, reason: "lock file vanished" };
    throw e;
  }
}

/**
 * FORCE-remove the lock, regardless of who holds it. The operator's fallback for
 * the case liveness cannot resolve: a pid that was recycled onto an unrelated
 * process looks alive forever, and without this the machine room would be
 * permanently wedged with no route back but hand-deleting a file.
 *
 * Deliberately dumb — it does NOT decide whether breaking is safe. The caller
 * owns that judgement (server.ts refuses when the holder is a live child it
 * spawned itself) because only the caller knows what it is running.
 */
export function breakLock(
  name: string,
  opts: LockOptions = {}
): { broken: boolean; was: LockHolder | null; reason: string } {
  const dir = opts.dir ?? DEFAULT_LOCK_DIR;
  const was = readLock(name, { dir });
  try {
    unlinkSync(lockPath(name, dir));
    return { broken: true, was, reason: was ? `broke a lock held by pid ${was.pid}` : "removed an unreadable lock file" };
  } catch (e) {
    if (errCode(e) === "ENOENT") return { broken: false, was: null, reason: "no lock file present" };
    throw e;
  }
}

/** Age of a holder in ms, or null when startedAt is missing/unparseable. */
export function holderAgeMs(holder: LockHolder | null, nowMs: number = Date.now()): number | null {
  if (!holder?.startedAt) return null;
  const t = Date.parse(holder.startedAt);
  return Number.isNaN(t) ? null : nowMs - t;
}

/** Current holder for display, with a liveness verdict attached. */
export function inspectLock(
  name: string,
  opts: LockOptions = {}
): { held: boolean; holder: LockHolder | null; alive: boolean } {
  const holder = readLock(name, opts);
  if (holder === null) return { held: false, holder: null, alive: false };
  const alive = (opts.isAlive ?? pidIsAlive)(holder.pid);
  return { held: true, holder, alive };
}
