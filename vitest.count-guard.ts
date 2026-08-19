// vitest.count-guard.ts — WD-ENG-10B: A SHORT RUN CAN NEVER AGAIN PRINT "passed".
//
// ── THE DEFECT, AS ACTUALLY DIAGNOSED ───────────────────────────────────────
// Full-suite runs intermittently report a LOWER test count. Instrumented soaks
// (75 runs across three pool configurations, plus a 30-run baseline) caught it
// repeatedly, and the cause is now known:
//
//   A test file fails to COLLECT with SQLite's "disk I/O error" (SQLITE_IOERR).
//   shared/cache.ts opens data/cache.sqlite AT MODULE LOAD and immediately runs
//   DDL writes; 39 modules import it, so parallel vitest workers all contend on
//   one sqlite file. The victim file DIFFERS every time — observed on
//   country-gate-reconcile (8 cases), wikipedia-lists-2026 (22), issue-anchor
//   (25) and verify (4), which is what produced the varying totals.
//
// ── THE CORRECTION THIS FILE EXISTS TO CARRY ────────────────────────────────
// Earlier packets claimed these runs "reported PASSED". THEY DID NOT. Every
// captured short run has `success: false` and an ELEVATED numFailedTestSuites
// (5 or 6 against a baseline of 4). vitest was reporting the failure correctly
// on its `Test Files` line the whole time; the monitoring in those packets
// grepped only the `Tests` line, which counts CASES and so looked green.
//
// The under-count is real. The silence was a measurement artefact. This guard
// therefore exists for the narrower, still-real reason that the `Tests` line is
// genuinely ambiguous on its own, and a case-count check makes a partial run
// unmistakable instead of something a reader must cross-reference to notice.
//
// ── WHY A PINNED CONSTANT AND NOT A COMPUTED ONE ────────────────────────────
// A purely static count is not achievable for this suite. Six files generate
// cases from RUNTIME data — template-lint.test.ts alone produces 95 cases from
// 6 `it` statements by iterating the template directory, and three `it.each`
// blocks iterate `readdirSync(src/jobs)`. An AST pass resolves 1201 of 1306;
// the rest exist only once the files have run. So the authority has to be a
// number a human updates, exactly like the floor numbers in the packets.
//
// UPDATING IT IS THE POINT, not a chore: adding tests is a deliberate act, and
// making the total explicit means an accidental LOSS of tests can no longer
// hide behind a green tick.

import type { Reporter, TestModule } from "vitest/node";

/**
 * The suite's full case count. Update deliberately when tests are added or
 * removed, and never to make a red run go green — a mismatch downward is the
 * exact symptom this file exists to catch.
 */
export const EXPECTED_TOTAL_TESTS = 1570;

/**
 * ── WD-ENG-10C: THE BYPASS IS CLOSED ────────────────────────────────────────
 * This guard USED to be listed in `test.reporters`, and a CLI `--reporter=X`
 * REPLACES that array rather than appending to it — silently unloading the
 * guard. Every command in the WD-ENG session passed `--reporter=dot`, so the
 * guard was not running for any of them: it disappeared under precisely the
 * conditions it exists to police.
 *
 * It is now attached from a `configureVitest` plugin hook in vitest.config.ts,
 * which runs after CLI options are merged and before the reporter list is
 * instantiated. `--reporter` can no longer unload it. Nothing here needs to
 * know that; the note is here because this is where a reader looks first.
 *
 * Filtered runs remain exempt, by `isFilteredRun()` below and nowhere else.
 */

/** Escape hatch for a deliberately filtered run (`-t`, a single file, etc.). */
const isFilteredRun = (): boolean =>
  process.argv.slice(2).some(
    (a) =>
      a === "-t" || a.startsWith("--testNamePattern") || a === "--changed" ||
      a.startsWith("--project") || a.startsWith("--shard") ||
      // A bare positional path filter (`vitest run src/foo.test.ts`).
      (!a.startsWith("-") && /\.(test|spec)\.ts$/.test(a))
  );

export default class CountGuardReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    if (isFilteredRun()) return;

    let total = 0;
    const perModule: Array<[string, number]> = [];
    for (const m of testModules) {
      let n = 0;
      for (const _ of m.children.allTests()) n += 1;
      total += n;
      perModule.push([m.moduleId.split(/[\\/]/).slice(-2).join("/"), n]);
    }

    if (total === EXPECTED_TOTAL_TESTS) return;

    const short = total < EXPECTED_TOTAL_TESTS;
    process.exitCode = 1;
    const lines = [
      "",
      "".padEnd(78, "━"),
      `  ⛔ COUNT GUARD: the suite ran ${total} test case(s); ${EXPECTED_TOTAL_TESTS} were expected.`,
      "".padEnd(78, "━"),
      short
        ? `  ${EXPECTED_TOTAL_TESTS - total} case(s) DID NOT RUN — almost certainly a test file that failed\n` +
          `  to COLLECT. Check the "Test Files ... failed" line for the victim.\n` +
          `  The historical cause was SQLite "disk I/O error" from parallel workers\n` +
          `  contending on data/cache.sqlite, which shared/cache.ts opened at module\n` +
          `  load; WD-ENG-10C made that open lazy, so a recurrence here is either a\n` +
          `  NEW module-scope db touch or a different cause entirely — find out which\n` +
          `  before assuming.\n` +
          `  DO NOT trust this run's green cases. Re-run; if it repeats, capture\n` +
          `  per-file counts with COUNT_GUARD_VERBOSE=1.`
        : `  ${total - EXPECTED_TOTAL_TESTS} MORE case(s) ran than expected. If you added tests, update\n` +
          `  EXPECTED_TOTAL_TESTS in vitest.count-guard.ts to ${total} in the same commit.`,
      `  modules reported: ${testModules.length}`,
      "".padEnd(78, "━"),
      "",
    ];
    // eslint-disable-next-line no-console
    console.error(lines.join("\n"));

    if (short && process.env.COUNT_GUARD_VERBOSE === "1") {
      // eslint-disable-next-line no-console
      console.error(perModule.map(([f, n]) => `      ${String(n).padStart(4)}  ${f}`).join("\n"));
    }
  }
}
