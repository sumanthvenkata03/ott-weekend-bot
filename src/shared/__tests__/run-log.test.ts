// WD-ENG-01 PART 4 — the run's reasoning survives the run.
//
// The tee (shared/logger.ts) already existed and was OPT-IN, which meant it was
// off exactly when it mattered. Three incidents in one week were partially
// unrecoverable because stdout was the only record — most sharply Issue 042,
// where the copy guard's STRIKE-1 warn line named the offender that ultimately
// cost Aroopi its slot, and that line died with a terminal window.
//
// The scratch directory is passed in rather than reached by process.chdir():
// chdir mutates state shared with every other test file in the same vitest
// worker, and doing it here broke all 75 files exactly once before being
// removed. The production default (RUN_LOG_DIR) is pinned separately below.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log, __resetLogTee } from "../logger.js";
import { startRunLog, RUN_LOG_DIR, runArtifactPath } from "../run-artifacts.js";

let dir: string;
const prev = process.env.TBSI_LOG_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-runlog-"));
  delete process.env.TBSI_LOG_FILE;
  __resetLogTee();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (prev === undefined) delete process.env.TBSI_LOG_FILE;
  else process.env.TBSI_LOG_FILE = prev;
  __resetLogTee();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const logs = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")) : []);

describe("the run log lands beside the run JSONs", () => {
  it("the production default is the SAME directory runArtifactPath writes to", () => {
    expect(RUN_LOG_DIR).toBe("output/runs");
    expect(runArtifactPath("wed-drop-ott", "2026-08-13", "draft")).toContain(`${RUN_LOG_DIR}/`);
  });

  it("the path is <dir>/<slug>-<timestamp>.log, and with the production dir that is output/runs/", () => {
    // NOTE: this deliberately does NOT call startRunLog() with the default dir.
    // startRunLog logs its own path, and that line goes through the tee it has
    // just enabled — so a default-dir call in a test writes a real file into the
    // repo's output/runs/. The path is composed from `dir` by one expression, so
    // pinning the composition here plus RUN_LOG_DIR above pins the production
    // string exactly, with no filesystem side effect on the repo.
    const path = startRunLog("wed-drop", new Date("2026-08-13T03:36:07.684Z"), dir);
    expect(path).toBe(`${dir}/wed-drop-2026-08-13T03-36-07-684Z.log`);
    expect(`${RUN_LOG_DIR}/wed-drop-2026-08-13T03-36-07-684Z.log`)
      .toBe("output/runs/wed-drop-2026-08-13T03-36-07-684Z.log");
  });
});

describe("the run log exists, unconditionally", () => {
  it("a dry-run invocation writes the file with no env var set", () => {
    expect(process.env.TBSI_LOG_FILE).toBeUndefined();

    startRunLog("wed-drop", new Date("2026-08-13T03:36:07.684Z"), dir);
    log.info("🎬 Wednesday Drop job — starting");

    expect(logs()).toEqual(["wed-drop-2026-08-13T03-36-07-684Z.log"]);
  });

  it("each run gets its own file — a re-run never overwrites the evidence", () => {
    startRunLog("wed-drop", new Date("2026-08-13T03:36:07.684Z"), dir);
    log.info("first run");
    delete process.env.TBSI_LOG_FILE;
    __resetLogTee();
    startRunLog("wed-drop", new Date("2026-08-13T04:12:00.000Z"), dir);
    log.info("second run");

    expect(logs().sort()).toEqual([
      "wed-drop-2026-08-13T03-36-07-684Z.log",
      "wed-drop-2026-08-13T04-12-00-000Z.log",
    ]);
  });

  it("an explicit TBSI_LOG_FILE still wins — an operator override is not overridden", () => {
    process.env.TBSI_LOG_FILE = join(dir, "operator.log");
    __resetLogTee();

    const path = startRunLog("wed-drop", new Date(), dir);

    expect(path).toBe(join(dir, "operator.log"));
    log.info("hello");
    expect(logs()).toEqual(["operator.log"]);           // the slug file was never made
  });
});

describe("THE 042 REGRESSION — the guard's warn lines are in the file", () => {
  it("captures strike 1, the fallback, the drop and the scrub verdict", () => {
    startRunLog("wed-drop", new Date("2026-08-13T03:36:07.684Z"), dir);

    // The exact lines generateWednesdayDrop emits, in order.
    log.warn(`Wed Drop [ott]: copy self-policing violation(s), retrying once — name:"Lights-off Malayalam" @Aroopi`);
    log.warn(`Wed Drop [ott]: copy self-policing — 2 strikes on 1 GATE-APPROVED film(s); blurb replaced with deterministic copy, film(s) SHIP: Aroopi`);
    log.error(`Wed Drop [ott]: copy self-policing — 2 strikes, dropping 1 UNFED film(s): Phantom Film`);
    log.warn(`Wed Drop [ott]: post-drop scrub clean — caption + index carry no trace of Phantom Film; counts retargeted to 6`);

    const body = readFileSync(join(dir, "wed-drop-2026-08-13T03-36-07-684Z.log"), "utf8");

    // STRIKE 1 — the line that did not survive Issue 042.
    expect(body).toContain(`copy self-policing violation(s), retrying once — name:"Lights-off Malayalam" @Aroopi`);
    expect(body).toContain("GATE-APPROVED");
    expect(body).toContain("dropping 1 UNFED film(s): Phantom Film");
    expect(body).toContain("post-drop scrub clean");

    // Levels and full ISO timestamps are preserved, and ANSI is stripped.
    expect(body).toContain("WARN");
    expect(body).toContain("ERR ");
    expect(body).toContain("2026-");
    expect(body).not.toContain("\x1b[");
  });
});
