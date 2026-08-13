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
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // Runs before every test FILE, in the same worker — this is what makes the
    // guard apply to all 84 without editing any of them.
    setupFiles: ["./vitest.setup.ts"],
    // WD-ENG-10B — "default" keeps the normal console output; the count guard
    // rides alongside it and fails the run when the total case count differs
    // from the pinned expectation. Without it, a run that silently skipped part
    // of the suite prints "passed" (observed at 1249 and 1228).
    reporters: ["default", "./vitest.count-guard.ts"],
  },
});
