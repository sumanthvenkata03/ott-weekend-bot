// scripts/movie-lookup/vitest.config.ts
// Tool-local vitest config. It ONLY collects the tool's *.check.ts files, so the
// repo's default `npx vitest run` (which matches *.test.ts / *.spec.ts) is never
// affected and the main suite stays exactly 190.
//
// Run: npx vitest run --config scripts/movie-lookup/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/movie-lookup/**/*.check.ts"],
    environment: "node",
    passWithNoTests: false,
  },
});
