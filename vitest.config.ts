// vitest.config.ts — WD-ENG-10.
//
// The repo had NO root vitest config: the full suite ran on defaults, and there
// was no seam for suite-wide setup. This adds one for a single purpose — loading
// the network guard (vitest.setup.ts) — and is otherwise written to reproduce
// the previous default discovery EXACTLY.
//
// `include` is pinned to src/**/*.{test,spec}.ts, which is precisely the 84
// files the default glob was already finding (0 test files exist outside src/).
// Stating it explicitly means a future stray *.test.ts somewhere unexpected
// cannot silently join — or silently leave — the run whose count we gate on.
//
// The two sub-project configs (scripts/machine-room, scripts/movie-lookup) are
// invoked by their own `--config` npm scripts and are untouched by this file.
//
// ── WD-ENG-10C: THE COUNT GUARD IS NO LONGER IN `test.reporters` ────────────
// It used to be listed there, and that was a guard with a documented bypass: a
// CLI `--reporter=X` REPLACES `test.reporters` wholesale rather than appending
// to it, silently unloading the guard. Every command in the WD-ENG session
// passed `--reporter=dot`, so the guard was inert for all of them — the one
// situation it exists to cover is exactly the situation in which it vanished.
// (Verified against vitest 4.1.9: a custom reporter in `test.reporters` runs on
// a bare `vitest run` and does not run under `--reporter=dot`.)
//
// It is now attached from a plugin's `configureVitest` hook instead. In vitest's
// startup order that hook runs AFTER the CLI options have been merged into the
// resolved config and BEFORE `createReporters(resolved.reporters, …)` reads it,
// so pushing an instance there lands in the final reporter list no matter what
// `--reporter` did to the array. `createReporters` passes non-string entries
// through untouched, which is why an already-constructed instance is the right
// thing to push. Confirmed running, and still failing the run with exit code 1,
// under `--reporter=dot` and `--reporter=json` as well as with no flag at all.
//
// The escape hatch is unchanged and still lives in the reporter: a deliberately
// FILTERED run (`-t`, `--shard`, `--project`, `--changed`, a positional file)
// returns early, so a single-file run is never a false alarm.
import { defineConfig } from "vitest/config";
import CountGuardReporter from "./vitest.count-guard.ts";

export default defineConfig({
  plugins: [
    {
      name: "tbsi:count-guard",
      configureVitest({ vitest }) {
        // Appended, never assigned: whatever the user or CLI chose to report
        // with is preserved, and the guard rides alongside it.
        vitest.config.reporters.push(new CountGuardReporter());
      },
    },
  ],
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // Runs before every test FILE, in the same worker — this is what makes the
    // guard apply to all 84 without editing any of them.
    setupFiles: ["./vitest.setup.ts"],
    // Console output only. The count guard is NOT here on purpose — see above.
    reporters: ["default"],
  },
});
