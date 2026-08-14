// WED_DROP_ALWAYS_GATE — the autonomy kill-switch default (ships dark).
//
// ── WD-ENG-04: THIS FILE USED TO RUN A REAL WEDNESDAY DROP ──────────────────
// wednesday-drop.ts invoked main() at MODULE SCOPE, so the import below executed
// the whole job on every suite run: two discovery sweeps, IMDb resolution, live
// OMDb requests (with the fake key this file mocks, retried twice each), credit
// enrichment and the country gate — none of which this file tests. Worse, the
// module-scope invocation ended in `.catch(… process.exit(1))`, so a rejection
// would have taken the vitest WORKER down with it, and the job was still running
// when the worker tore down (its run log stopped mid-enrichment while these eight
// assertions had long since finished).
//
// The job now carries the hardened entry guard every other job module has, so
// importing it executes NOTHING. main() is exported and, below, called
// DELIBERATELY with its first network seam mocked — the test owns the rejection,
// so no code path can reach process.exit.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

vi.mock("../../shared/config.js", () => ({
  config: { NOTION_TOKEN: "test", TMDB_API_KEY: "test", OMDB_API_KEY: "test", MDBLIST_API_KEY: "" },
}));

// THE NETWORK SEAM. main()'s first outbound work is getCandidates(); mocking it
// to throw means the run is over before a single request is made, and what the
// test exercises is the part that matters here — that main() is callable, that
// its failure is a plain rejected promise, and that nothing kills the worker.
const BOOM = "getCandidates blocked by test — no network in this suite";
vi.mock("../../discovery/candidates.js", () => ({
  getCandidates: vi.fn(async () => { throw new Error(BOOM); }),
}));

// Deterministic provenance. assertPublishableTree shells out to git and REFUSES a
// scheduled run on a dirty tree, so on CI (where GITHUB_ACTIONS is set) the real
// one would make this test's outcome depend on the checkout's cleanliness.
vi.mock("../../shared/run-context.js", async (orig) => ({
  ...(await orig<typeof import("../../shared/run-context.js")>()),
  assertPublishableTree: () => ({ headSha: "testsha", dirty: false, scheduled: false }),
}));

// purgeExpired writes to the developer's real cache.sqlite. Harmless (it only
// deletes already-expired rows) but a test has no business mutating it.
vi.mock("../../shared/cache.js", async (orig) => ({
  ...(await orig<typeof import("../../shared/cache.js")>()),
  purgeExpired: vi.fn(),
}));

const { resolveAlwaysGate, main } = await import("../wednesday-drop.js");

const RUNS_DIR = join(process.cwd(), "output", "runs");
const runsSnapshot = () => (existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).sort() : []);

// ── WD-ENG-10C: THE TEMP-LOG PATH USED TO BE KEYED ON THE PID ALONE ─────────
// `tbsi-test-${process.pid}.log` is not unique. It is unique only among LIVE
// processes: the OS recycles PIDs freely, and vitest spawns a fresh worker pool
// per run, so a later run's worker can be handed the PID an earlier run's worker
// had. It then points at that run's leftover file — which two of the cases below
// treat as evidence ("no run log exists yet" / "a run log now exists"). The
// first of those flips to a false FAILURE the moment the file is inherited, and
// it is a genuinely intermittent failure because it needs the recycle to land.
//
// Belt AND braces, because this one cost two packets of misattribution:
//   BELT   — a random component, so no two paths ever coincide, across runs or
//            within one (each case gets its own file, so cases cannot pollute
//            each other either).
//   BRACES — an unconditional delete of the target path before use, so even a
//            path that somehow DID repeat starts from nothing.
// Either alone would close the hole. Both together mean a future edit that
// weakens one still leaves the other standing.
const freshLogPath = (): string =>
  join(tmpdir(), `tbsi-test-${process.pid}-${randomUUID()}.log`);

/** BRACES: guarantee nothing is sitting at `path` before a case relies on it. */
const armLogPathAt = (path: string): string => {
  rmSync(path, { force: true });
  return path;
};

const armLogPath = (): string => armLogPathAt(freshLogPath());

let prevTee: string | undefined;
beforeEach(() => {
  prevTee = process.env.TBSI_LOG_FILE;
  // The run log must land in temp, not in the repo's output/runs/.
  process.env.TBSI_LOG_FILE = armLogPath();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  // Don't leave one file per case behind in temp now that paths are unique.
  if (process.env.TBSI_LOG_FILE) rmSync(process.env.TBSI_LOG_FILE, { force: true });
  if (prevTee === undefined) delete process.env.TBSI_LOG_FILE;
  else process.env.TBSI_LOG_FILE = prevTee;
  vi.restoreAllMocks();
});

describe("WD-ENG-10C — the run-log temp path cannot collide across runs", () => {
  it("a recycled PID cannot inherit an earlier run's log file", () => {
    // Stand in for "an earlier run, same PID, left this behind". Under the old
    // PID-only scheme this IS the path this run would have been handed.
    const pidOnly = join(tmpdir(), `tbsi-test-${process.pid}.log`);
    writeFileSync(pidOnly, "stale run log from an earlier process with this same PID");
    try {
      expect(existsSync(pidOnly)).toBe(true);

      const first = armLogPath();
      const second = armLogPath();

      // BELT, three ways: not the PID-only path, not each other, and each empty.
      expect(first).not.toBe(pidOnly);
      expect(second).not.toBe(pidOnly);
      expect(first).not.toBe(second);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(false);
      // The PID is still in the name — it stays useful for attribution.
      expect(first).toContain(`tbsi-test-${process.pid}-`);
    } finally {
      rmSync(pidOnly, { force: true });
    }
  });

  it("arming a path that already exists deletes it — the braces, independently", () => {
    // Proves the cleanup does the work on its own, so the fix does not rest
    // solely on randomness never repeating.
    const path = armLogPath();
    writeFileSync(path, "left over");
    expect(existsSync(path)).toBe(true);

    expect(armLogPathAt(path)).toBe(path);
    expect(existsSync(path)).toBe(false);
  });
});

describe("resolveAlwaysGate — gate is ON unless explicitly disarmed", () => {
  it("DEFAULT (unset) ⇒ gate ON — autonomy ships dark", () => {
    expect(resolveAlwaysGate(undefined)).toBe(true);
  });

  it('explicit "false" ⇒ gate OFF (operator disarmed)', () => {
    expect(resolveAlwaysGate("false")).toBe(false);
  });

  it('explicit "0" ⇒ gate OFF', () => {
    expect(resolveAlwaysGate("0")).toBe(false);
  });

  it('explicit "true" ⇒ gate ON', () => {
    expect(resolveAlwaysGate("true")).toBe(true);
  });

  it('explicit "1" ⇒ gate ON', () => {
    expect(resolveAlwaysGate("1")).toBe(true);
  });

  it("empty string and whitespace ⇒ gate ON (unset-equivalent)", () => {
    expect(resolveAlwaysGate("")).toBe(true);
    expect(resolveAlwaysGate("   ")).toBe(true);
  });

  it("disarm is case- and whitespace-insensitive", () => {
    expect(resolveAlwaysGate("FALSE")).toBe(false);
    expect(resolveAlwaysGate(" 0 ")).toBe(false);
  });

  it("any other value keeps the gate ON — only false/0 disarm", () => {
    for (const v of ["yes", "no", "off", "on", "2", "gate"]) {
      expect(resolveAlwaysGate(v)).toBe(true);
    }
  });
});

describe("WD-ENG-04 — importing this job executes nothing", () => {
  // FIRST in file order on purpose: it asserts state that only holds before any
  // deliberate main() call below has run.
  it("the import above ran NO job: no run log, no artifacts, no network", async () => {
    // The module has been imported for the whole file. If the entry guard were
    // broken, a run log would exist by now (main()'s second statement writes one)
    // and getCandidates would already have been reached.
    expect(existsSync(process.env.TBSI_LOG_FILE!)).toBe(false);
    const { getCandidates } = await import("../../discovery/candidates.js");
    expect(vi.mocked(getCandidates)).not.toHaveBeenCalled();
  });
});

describe("WD-ENG-04 — main() is called deliberately and its rejection is OURS", () => {
  it("main() rejects into the test; the worker survives; process.exit is never reached", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) reached — the worker would have died`);
    }) as never);

    // THE POINT: the rejection is handled HERE. Under the old module-scope
    // invocation this same failure ran into `.catch(… process.exit(1))` inside a
    // vitest worker, which is the "all files failed / no tests" signature.
    await expect(main()).rejects.toThrow(BOOM);

    expect(exitSpy).not.toHaveBeenCalled();
    // …and this assertion running at all is the proof the worker is still alive.
    expect(true).toBe(true);
  });

  it("a deliberate run performs NO network I/O — it stops at the mocked seam", async () => {
    const { getCandidates } = await import("../../discovery/candidates.js");
    await expect(main()).rejects.toThrow(BOOM);
    // Both editions asked; neither reached a real fetch.
    expect(vi.mocked(getCandidates).mock.calls.length).toBeGreaterThan(0);
  });

  it("a deliberate run writes NOTHING into the repo's output/runs/", async () => {
    const before = runsSnapshot();
    await expect(main()).rejects.toThrow(BOOM);
    expect(runsSnapshot()).toEqual(before);
  });

  it("the WD-ENG-01 log tee DOES fire on real execution — guarded, not disabled", async () => {
    // The tee is unconditional at the entry point; the guard only stops IMPORT
    // from being an execution. Running main() for real must still persist a log.
    await expect(main()).rejects.toThrow(BOOM);
    expect(existsSync(process.env.TBSI_LOG_FILE!)).toBe(true);
  });
});
