// scripts/machine-room/lockself.check.ts
// M1.1 — THE SELF-DEADLOCK, AND THE ESCAPE HATCH.
//
// THE BUG THIS PINS. The run path takes the publish lock and only THEN runs
// preflight — deliberately, so two simultaneous clicks cannot both pass
// preflight and both spawn. But preflight then read the lockfile the run had
// just written and REDed on it, so the very first real Run click came back:
//
//   HTTP 412  preflight failed   stoppedAt=publish lock
//   [RED ] publish lock  HELD by live pid 10564 running Reddit Radar since …
//
// — the job it was starting. 100% reproducible, every job, every time. The fix
// is to pass the holder identity in, NOT to reorder preflight before acquire,
// which would fix the symptom and reopen the two-clicks race.
//
// Offline: injected liveness and injected clock throughout.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, breakLock, holderAgeMs, inspectLock, lockPath, readLock } from "./lock.js";
import { classifyLock, runPreflight, STALE_AGE_MS, type PreflightDeps } from "./preflight.js";

let dir: string;
const NAME = "publish";
const alive = () => true;
const dead = () => false;
const T0 = Date.parse("2026-07-30T12:00:00.000Z");

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tbsi-lockself-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const holder = (pid: number, startedAt = new Date(T0).toISOString(), jobName = "Reddit Radar") => ({
  held: true,
  alive: true,
  holder: { pid, startedAt, jobName, argv: [] },
});

// ── FIX (a): the run path recognises its own lock ───────────────────────────

describe("SELF-HOLDER — the run path must not RED on the lock it just took", () => {
  it("PASSES when the holder pid is the caller's own", () => {
    const c = classifyLock(holder(10564), { selfHolderPid: 10564, nowMs: T0 + 50 });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("THIS run");
    expect(c.detail).toContain("10564");
  });

  it("still REFUSES a FOREIGN live holder — the race guard is untouched", () => {
    const c = classifyLock(holder(999), { selfHolderPid: 10564, nowMs: T0 + 50 });
    expect(c.ok).toBe(false);
    expect(c.level).toBe("red");
    expect(c.detail).toContain("HELD by live pid 999");
  });

  it("without a selfHolderPid, behaviour is exactly as before (the standalone button)", () => {
    const c = classifyLock(holder(10564), { nowMs: T0 + 50 });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("HELD by live");
  });

  it("a free lock passes either way", () => {
    expect(classifyLock({ held: false, holder: null, alive: false }).ok).toBe(true);
    expect(classifyLock({ held: false, holder: null, alive: false }, { selfHolderPid: 1 }).ok).toBe(true);
  });
});

describe("THE ORIGINAL ACCEPTANCE PATH — a full preflight with the lock self-held", () => {
  function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
    return {
      adminTokenPresent: true,
      keys: { requiredLoaded: true, tavily: true, mdblist: true },
      tree: { provenance: "d008480 · tree clean · manual", dirty: false },
      lock: holder(10564),
      diskFreeBytes: 50 * 1024 * 1024 * 1024,
      claude: async () => ({ kind: "ok", ms: 900 }),
      chromium: async () => ({ ok: true }),
      ...over,
    };
  }

  it("REPRODUCES the bug when the identity is not passed", async () => {
    const r = await runPreflight(deps());
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe("publish lock");
  });

  it("COMPLETES when the run passes its own holder pid", async () => {
    const r = await runPreflight(deps({ selfHolderPid: 10564 }));
    expect(r.ok).toBe(true);
    expect(r.stoppedAt).toBeUndefined();
    expect(r.checks.find((c) => c.name === "publish lock")!.detail).toContain("THIS run");
  });

  it("a foreign holder still aborts BEFORE the billable claude probe", async () => {
    let claudeCalls = 0;
    const r = await runPreflight(deps({
      lock: holder(999),
      selfHolderPid: 10564,
      claude: async () => { claudeCalls++; return { kind: "ok", ms: 1 }; },
    }));
    expect(r.stoppedAt).toBe("publish lock");
    expect(claudeCalls).toBe(0);
  });
});

// ── FIX (b): age-aware staleness ────────────────────────────────────────────

describe("STALE AGE — kill(pid,0) alone cannot prove a 6h-old holder is real", () => {
  it("under 6h reads as a plain live holder", () => {
    const c = classifyLock(holder(999), { nowMs: T0 + STALE_AGE_MS - 1000 });
    expect(c.detail).toContain("HELD by live");
    expect(c.detail).not.toContain("PROBABLY STALE");
  });

  it("over 6h is reported as PROBABLY STALE and names pid recycling", () => {
    const c = classifyLock(holder(999), { nowMs: T0 + STALE_AGE_MS + 3_600_000 });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("PROBABLY STALE");
    expect(c.detail).toContain("recycled");
    expect(c.detail).toContain("Break Lock");
    expect(c.detail).toContain("held for 7h");
  });

  it("still REFUSES rather than auto-breaking — the operator decides", () => {
    expect(classifyLock(holder(999), { nowMs: T0 + STALE_AGE_MS * 10 }).ok).toBe(false);
  });

  it("a self-held lock is never called stale, however old", () => {
    const c = classifyLock(holder(10564), { selfHolderPid: 10564, nowMs: T0 + STALE_AGE_MS * 10 });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("THIS run");
  });

  it("an unparseable startedAt degrades to the plain live message", () => {
    const c = classifyLock({ held: true, alive: true, holder: { pid: 9, startedAt: "junk", jobName: "X", argv: [] } });
    expect(c.detail).toContain("HELD by live");
  });

  it("holderAgeMs handles missing / bad timestamps", () => {
    expect(holderAgeMs(null)).toBeNull();
    expect(holderAgeMs({ pid: 1, startedAt: "", jobName: "", argv: [] })).toBeNull();
    expect(holderAgeMs({ pid: 1, startedAt: "nope", jobName: "", argv: [] })).toBeNull();
    expect(holderAgeMs({ pid: 1, startedAt: new Date(T0).toISOString(), jobName: "", argv: [] }, T0 + 5000)).toBe(5000);
  });
});

// ── Break lock ──────────────────────────────────────────────────────────────

describe("BREAK LOCK — the escape hatch for a lock liveness cannot resolve", () => {
  it("clears a DEAD holder's lock", () => {
    acquireLock(NAME, { pid: 111, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    const r = breakLock(NAME, { dir });
    expect(r.broken).toBe(true);
    expect(r.was?.pid).toBe(111);
    expect(existsSync(lockPath(NAME, dir))).toBe(false);
  });

  it("clears a lock whose pid merely LOOKS alive (the recycled-pid case)", () => {
    acquireLock(NAME, { pid: 222, jobName: "Sat Verdict", argv: [] }, { dir, isAlive: dead });
    expect(inspectLock(NAME, { dir, isAlive: alive }).alive).toBe(true);
    expect(breakLock(NAME, { dir }).broken).toBe(true);
    expect(readLock(NAME, { dir })).toBeNull();
  });

  it("reports honestly when there is nothing to break", () => {
    const r = breakLock(NAME, { dir });
    expect(r.broken).toBe(false);
    expect(r.reason).toContain("no lock file");
  });

  it("a broken lock is immediately re-acquirable", () => {
    acquireLock(NAME, { pid: 111, jobName: "A", argv: [] }, { dir, isAlive: alive });
    breakLock(NAME, { dir });
    const again = acquireLock(NAME, { pid: 222, jobName: "B", argv: [] }, { dir, isAlive: alive });
    expect(again.ok).toBe(true);
  });
});
