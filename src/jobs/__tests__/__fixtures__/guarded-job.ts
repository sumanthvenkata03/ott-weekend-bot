// src/jobs/__tests__/__fixtures__/guarded-job.ts
// A JOB-SHAPED MODULE whose main() always rejects, carrying the same hardened
// entry guard every real job now has.
//
// It exists so the worker-survival property can be proven against a module that
// really would blow up, without importing a real job (which would pull config,
// sqlite and the network into a test about module loading).
//
// There is deliberately NO unguarded twin. An unguarded module whose main()
// rejects is precisely the thing that kills a vitest worker, so the contrast is
// asserted at SOURCE level in the accompanying test rather than by executing it.

/** Incremented only if main() actually runs. The side-effect sentinel. */
export const sideEffects: string[] = [];

export const BOOM = "guarded-job main() rejected — this must never reach process.exit";

export async function main(): Promise<void> {
  sideEffects.push("main ran");
  throw new Error(BOOM);
}

// Hardened truthiness guard — endsWith("") is vacuously true, so the argv1.length
// clause stops a bare import from running main (the runs-main-on-import landmine).
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMainModule = argv1.length > 0 && import.meta.url.endsWith(argv1);

if (isMainModule) {
  main().catch(() => {
    process.exit(1);
  });
}
