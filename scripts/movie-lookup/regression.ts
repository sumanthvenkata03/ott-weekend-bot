// scripts/movie-lookup/regression.ts
// One-command regression runner for the movie-lookup tool. READ-ONLY, runs NO
// job:*. Run it with:
//
//   npx tsx scripts/movie-lookup/regression.ts
//
// It verifies, printing a clear PASS/FAIL per check:
//   (i)  repo baseline is intact:
//        - npx tsc --noEmit          → exactly 44 errors
//        - npx vitest run            → exactly 523 passed (Issue 016 enforcement pin
//          + Wed Drop copy self-policing + data-source integrity: Kannada parser
//          canary / OMDb cross-source sanity / Bengali trim + One-Time Watch taxonomy
//          + the News Desk suites: gather window / clustering / class matcher /
//          dedupe ledger / composer rules / N1 receipt rule
//          + the SAFETY CORE: country gate at all three seams — ingest / reconcile /
//          news-resolve — plus the seven-language realignment)
//        - computeDropHash(FIXED)    → green ("92bcfb40772d")
//   (ii) the tool's own tests (*.check.ts) all pass.

import { execSync } from "node:child_process";

const BASELINE_TSC = 44;
const BASELINE_TESTS = 523;

interface Check { name: string; pass: boolean; detail: string; }
const results: Check[] = [];

function run(cmd: string): { code: number; out: string } {
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: "pipe", env: process.env });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function countTscErrors(out: string): number {
  return (out.match(/error TS\d+/g) ?? []).length;
}
function lastPassedCount(out: string): number | null {
  const matches = [...out.matchAll(/(\d+)\s+passed/g)];
  const last = matches[matches.length - 1];
  return last ? Number.parseInt(last[1]!, 10) : null;
}
function looksLikeTransient(out: string): boolean {
  // Known flake: a cold vitest worker reports every file "No test suite found".
  return /no tests/i.test(out) && /Test Files\s+\d+ failed \(\d+\)/.test(out) && !/passed/.test(out);
}

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"}  ${name} — ${detail}`);
}

console.log("\n=== TBSI movie-lookup · full regression (read-only) ===\n");

// (i) tsc
console.log("[1/4] tsc --noEmit …");
{
  const { out } = run("npx tsc --noEmit");
  const n = countTscErrors(out);
  record("tsc baseline", n === BASELINE_TSC, `${n} errors (expected ${BASELINE_TSC})`);
}

// (ii) main vitest suite (with one retry for the known transient)
console.log("[2/4] vitest run (main suite) …");
{
  let { out } = run("npx vitest run");
  if (looksLikeTransient(out)) {
    console.log("      (transient 'no tests' worker hiccup — re-running once)");
    ({ out } = run("npx vitest run"));
  }
  const passed = lastPassedCount(out);
  record("main suite", passed === BASELINE_TESTS, `${passed ?? "?"} passed (expected ${BASELINE_TESTS})`);
}

// (iii) pinned drop-hash test
console.log("[3/4] computeDropHash(FIXED) …");
{
  const { code, out } = run("npx vitest run src/reconcile/__tests__/gate-shared.test.ts");
  const passed = lastPassedCount(out);
  record("drop-hash pinned", code === 0 && (passed ?? 0) >= 1, `exit ${code}, ${passed ?? 0} passed`);
}

// (iv) tool tests
console.log("[4/4] tool tests (*.check.ts) …");
{
  const { code, out } = run("npx vitest run --config scripts/movie-lookup/vitest.config.ts");
  const passed = lastPassedCount(out);
  record("tool tests", code === 0 && (passed ?? 0) >= 1, `exit ${code}, ${passed ?? 0} passed`);
}

const allPass = results.every((r) => r.pass);
console.log(`\n=== SUMMARY: ${results.filter((r) => r.pass).length}/${results.length} checks passed — ${allPass ? "ALL GREEN ✅" : "FAILURES ❌"} ===\n`);
process.exit(allPass ? 0 : 1);
