// scripts/machine-room/lock.check.ts
// THE PUBLISH LOCK. The dangerous path is stale-takeover: a liveness test that
// is wrong in the "kills it" direction would terminate a running job, and one
// that is wrong in the "looks dead" direction would allow two concurrent runs —
// which recon showed corrupts the ledger, deletes cards mid-upload, and double-
// spends ~34 Tavily credits. Both directions are pinned here.
//
// Offline: every case injects its own isAlive, so no real process is signalled.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, inspectLock, lockPath, pidIsAlive, readLock, releaseLock } from "./lock.js";

let dir: string;
const NAME = "publish";
const alive = () => true;
const dead = () => false;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tbsi-lock-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("acquire / release — the happy path", () => {
  it("creates the lock file with pid, job and argv", () => {
    const r = acquireLock(NAME, { pid: 4242, jobName: "Wed Drop", argv: ["npx", "tsx", "x.ts"] }, { dir, isAlive: dead });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tookOver).toBeNull();
    const onDisk = JSON.parse(readFileSync(lockPath(NAME, dir), "utf8"));
    expect(onDisk.pid).toBe(4242);
    expect(onDisk.jobName).toBe("Wed Drop");
    expect(onDisk.argv).toEqual(["npx", "tsx", "x.ts"]);
    expect(typeof onDisk.startedAt).toBe("string");
  });

  it("releases only for its own pid, and the file goes away", () => {
    acquireLock(NAME, { pid: 4242, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    expect(releaseLock(NAME, 4242, { dir }).released).toBe(true);
    expect(existsSync(lockPath(NAME, dir))).toBe(false);
  });

  it("a second acquire succeeds once the first released", () => {
    acquireLock(NAME, { pid: 1, jobName: "A", argv: [] }, { dir, isAlive: alive });
    releaseLock(NAME, 1, { dir });
    const second = acquireLock(NAME, { pid: 2, jobName: "B", argv: [] }, { dir, isAlive: alive });
    expect(second.ok).toBe(true);
  });
});

describe("a LIVE holder is refused — never two concurrent runs", () => {
  it("refuses and reports who holds it", () => {
    acquireLock(NAME, { pid: 111, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    const second = acquireLock(NAME, { pid: 222, jobName: "Sat Verdict", argv: [] }, { dir, isAlive: alive });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.holder.pid).toBe(111);
    expect(second.holder.jobName).toBe("Wed Drop");
    expect(second.reason).toContain("LIVE");
    expect(second.reason).toContain("111");
  });

  it("does NOT overwrite the incumbent's file", () => {
    acquireLock(NAME, { pid: 111, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    acquireLock(NAME, { pid: 222, jobName: "Sat Verdict", argv: [] }, { dir, isAlive: alive });
    expect(readLock(NAME, { dir })!.pid).toBe(111);
  });
});

describe("a DEAD holder is taken over", () => {
  it("takes over and reports the displaced holder so it can be logged", () => {
    acquireLock(NAME, { pid: 111, jobName: "Crashed Wed Drop", argv: [] }, { dir, isAlive: dead });
    const second = acquireLock(NAME, { pid: 222, jobName: "Sat Verdict", argv: [] }, { dir, isAlive: dead });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.tookOver?.pid).toBe(111);
    expect(second.tookOver?.jobName).toBe("Crashed Wed Drop");
    expect(readLock(NAME, { dir })!.pid).toBe(222);
  });

  it("takes over a CORRUPT lock file rather than wedging forever", () => {
    writeFileSync(lockPath(NAME, dir), "{not json", "utf8");
    const r = acquireLock(NAME, { pid: 7, jobName: "X", argv: [] }, { dir, isAlive: alive });
    expect(r.ok).toBe(true);
    expect(readLock(NAME, { dir })!.pid).toBe(7);
  });
});

describe("release refuses a FOREIGN pid", () => {
  it("will not delete a lock held by someone else", () => {
    acquireLock(NAME, { pid: 111, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    const r = releaseLock(NAME, 999, { dir });
    expect(r.released).toBe(false);
    expect(r.reason).toContain("111");
    expect(existsSync(lockPath(NAME, dir))).toBe(true);
  });

  it("reports honestly when there is nothing to release", () => {
    expect(releaseLock(NAME, 1, { dir }).released).toBe(false);
  });
});

describe("inspectLock — what the banner shows", () => {
  it("free when absent", () => {
    expect(inspectLock(NAME, { dir, isAlive: alive })).toEqual({ held: false, holder: null, alive: false });
  });
  it("distinguishes a live holder from a stale one", () => {
    acquireLock(NAME, { pid: 55, jobName: "Wed Drop", argv: [] }, { dir, isAlive: dead });
    expect(inspectLock(NAME, { dir, isAlive: alive }).alive).toBe(true);
    expect(inspectLock(NAME, { dir, isAlive: dead }).alive).toBe(false);
  });
});

describe("pidIsAlive — the real probe (verified on win32)", () => {
  it("says THIS process is alive", () => {
    expect(pidIsAlive(process.pid)).toBe(true);
  });
  it("says an impossible pid is dead", () => {
    expect(pidIsAlive(999999)).toBe(false);
  });
  it("rejects nonsense pids without throwing", () => {
    expect(pidIsAlive(0)).toBe(false);
    expect(pidIsAlive(-1)).toBe(false);
    expect(pidIsAlive(1.5)).toBe(false);
  });
  it("probing does NOT kill — this process survives probing itself", () => {
    pidIsAlive(process.pid);
    pidIsAlive(process.pid);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });
});
