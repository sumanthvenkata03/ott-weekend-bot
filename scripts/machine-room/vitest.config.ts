// scripts/machine-room/vitest.config.ts
// Tool-local vitest config, mirroring scripts/movie-lookup/vitest.config.ts.
// It ONLY collects this folder's *.check.ts files, so `npx vitest run --dir src`
// (the main 832-test suite) is untouched and movie-lookup's 135 checks are
// untouched. Run:
//   npx vitest run --config scripts/machine-room/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/machine-room/**/*.check.ts"],
    environment: "node",
    passWithNoTests: false,
    // The server integration check spawns a real child and waits for a port.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
