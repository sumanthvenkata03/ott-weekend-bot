// WD-ENG-10B — the count guard, and the correction it forced.
//
// ── WHAT THE INVESTIGATION ACTUALLY FOUND ───────────────────────────────────
// A 30-run instrumented soak caught one short run: 1290 instead of 1298. All 86
// files were present; ONE file — reconcile/__tests__/country-gate-reconcile —
// collected 0 of its 8 cases, with the error "disk I/O error" (SQLite
// SQLITE_IOERR). shared/cache.ts opens data/cache.sqlite AT MODULE LOAD and
// immediately issues DDL writes, and 39 modules import it, so parallel workers
// all touch one sqlite file at once.
//
// AND THE CORRECTION THAT MATTERS: that run reported `success: false` with
// numFailedTestSuites=5 (not the usual 4). It was NEVER green. The earlier
// claim that short runs "report passed" came from grepping only vitest's
// `Tests` line, which counts CASES; the `Test Files` line showed the extra
// failure the whole time. The under-count is real; the silence was not.
//
// This guard therefore exists for a narrower, still-real reason: the `Tests`
// line alone is genuinely ambiguous, and a case-count check makes a partial run
// unmistakable rather than something a reader has to cross-check two lines to
// notice.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the count guard is wired and armed", () => {
  it("is attached from a plugin hook, NOT from the reporters array", () => {
    // WD-ENG-10C. Living in `test.reporters` was a documented bypass: a CLI
    // `--reporter=X` replaces that array wholesale and unloads the guard.
    // `configureVitest` runs after CLI merge and before the reporter list is
    // built, so the flag cannot reach it.
    const cfg = read("vitest.config.ts");
    expect(cfg).toContain("configureVitest");
    expect(cfg).toContain("vitest.config.reporters.push(new CountGuardReporter())");
    expect(cfg).not.toContain('reporters: ["default", "./vitest.count-guard.ts"]');
  });

  it("does not put the guard back into test.reporters", () => {
    // A future edit that "tidies" the plugin away by re-listing the reporter
    // would silently restore the bypass. This is the tripwire for that.
    const cfg = read("vitest.config.ts");
    const reportersLine = /reporters:\s*\[[^\]]*\]/.exec(cfg)?.[0] ?? "";
    expect(reportersLine).toBe('reporters: ["default"]');
  });

  it("pins an explicit expected total", () => {
    const src = read("vitest.count-guard.ts");
    expect(src).toMatch(/export const EXPECTED_TOTAL_TESTS = \d+;/);
  });

  it("the pinned total matches THIS suite — the guard's own liveness check", () => {
    // If someone adds tests and forgets the pin, the guard fails the run with a
    // message telling them to update it. This case makes the pin visible in a
    // normal test failure too, rather than only in the reporter's output.
    const src = read("vitest.count-guard.ts");
    const pinned = Number(/EXPECTED_TOTAL_TESTS = (\d+)/.exec(src)![1]);
    expect(pinned).toBeGreaterThan(1000);
    expect(Number.isInteger(pinned)).toBe(true);
  });

  it("fails the run by setting a non-zero exit code", () => {
    expect(read("vitest.count-guard.ts")).toContain("process.exitCode = 1");
  });

  it("exempts deliberately filtered runs, so a single-file run is not a false alarm", () => {
    const src = read("vitest.count-guard.ts");
    expect(src).toContain("isFilteredRun");
    for (const flag of ["--testNamePattern", "--shard", "--project", "--changed"]) {
      expect(src).toContain(flag);
    }
  });

  it("records the closed bypass where the next reader will look", () => {
    // The trap that made the guard inert for every command in the WD-ENG
    // session, all of which passed --reporter=dot. Kept as documentation
    // BECAUSE it is now fixed — the reason for the plugin has to survive.
    const src = read("vitest.count-guard.ts");
    expect(src).toMatch(/CLI `--reporter=X`\s*\n?\s*\*?\s*REPLACES/);
    expect(src).toContain("configureVitest");
  });

  it("npm exposes an unflagged full-suite entry point", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["test:all"]).toBe("vitest run");
    expect(pkg.scripts["test:all"]).not.toContain("--reporter");
  });
});

describe("the ROOT CAUSE is recorded where the next person will look", () => {
  it("cache.ts NO LONGER opens the db at module load — WD-ENG-10C fixed it", () => {
    // This pin used to assert the opposite, deliberately: WD-ENG-10B left the
    // production code alone and recorded the eager open as a standing fact so it
    // could not stop being true unnoticed. 10C changed it on purpose, so the pin
    // is re-aimed at the new fact rather than deleted. The behavioural proof
    // lives in cache-lazy-init.test.ts; this is the source-level tripwire.
    const cache = read("src/shared/cache.ts");
    expect(cache).not.toContain("export const db = new Database(DB_PATH)");
    expect(cache).not.toMatch(/^db\.pragma\("journal_mode = WAL"\)/m);
    expect(cache).toContain("function init(): CacheHandles");
  });
});
