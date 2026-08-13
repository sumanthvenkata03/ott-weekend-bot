// WD-ENG-04 PART 4 — IMPORT SAFETY, PINNED FOR EVERY JOB.
//
// Companion to src/discovery/__tests__/import-safety.test.ts, which locks the
// same property for the discovery surface. That file's header states the rule
// this one generalises: importing a module must be "a pure, side-effect-free
// operation that never exits and never throws".
//
// Wednesday's job broke that rule for as long as it has existed: `main()` sat at
// module scope with `.catch(… process.exit(1))`, so importing it ran a real,
// networked Wednesday Drop, and a rejection inside a vitest worker called
// process.exit on that worker. The observable signature is every test file
// failing at once with "no tests" — the crash this packet removes the mechanism
// for. (Unreproduced on demand; this is mechanism removal, not a proven fix.)
//
// Two layers, because they fail differently:
//   SOURCE  — every job carries the hardened guard and no bare module-scope
//             main(). Environment-independent; catches a regression the moment
//             it is written, on any machine, with no env vars set.
//   RUNTIME — a job-shaped fixture whose main() rejects is imported for real:
//             nothing executes, and calling main() by hand leaves the worker up.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const JOBS_DIR = join(process.cwd(), "src", "jobs");
const read = (f: string) => readFileSync(join(JOBS_DIR, f), "utf8");
/** Drop comments so prose about main() cannot satisfy — or break — a pin. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Every job module — read from disk, so a NEW job is covered automatically. */
const JOB_FILES = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".ts"));

const HARDENED = "argv1.length > 0 && import.meta.url.endsWith(argv1)";

describe("SOURCE PIN — every job module guards its entry point", () => {
  it("the job list is non-empty and complete (a new job is covered the day it lands)", () => {
    expect(JOB_FILES.length).toBeGreaterThanOrEqual(8);
    for (const expected of [
      "wednesday-drop.ts", "monday-movement.ts", "saturday-verdict.ts",
      "sunday-spotlight.ts", "friday-archives.ts", "thursday-compare.ts",
      "news-edition.ts", "reddit-radar.ts",
    ]) {
      expect(JOB_FILES).toContain(expected);
    }
  });

  it.each(JOB_FILES)("%s carries the HARDENED entry guard", (f) => {
    // The one-clause form `import.meta.url.endsWith(argv[1] ?? "")` is NOT
    // sufficient: endsWith("") is vacuously true, so an import with an empty
    // argv[1] runs main anyway. news-edition.ts's header has warned about this
    // for as long as it has existed; now every job uses the hardened form.
    expect(code(read(f))).toContain(HARDENED);
  });

  it.each(JOB_FILES)("%s invokes main() ONLY inside the guard", (f) => {
    const src = code(read(f));
    const guardAt = src.indexOf("if (isMainModule) {");
    expect(guardAt, `${f}: no isMainModule guard block`).toBeGreaterThan(-1);

    // Every CALL of main( — as opposed to its declaration — must sit after the
    // guard opens. `function main(` / `export async function main(` are the
    // declaration and are excluded by requiring the call not be preceded by
    // "function ".
    for (let i = src.indexOf("main("); i !== -1; i = src.indexOf("main(", i + 1)) {
      const before = src.slice(Math.max(0, i - 24), i);
      if (before.includes("function ")) continue;   // the declaration
      expect(i, `${f}: main() invoked outside the entry guard`).toBeGreaterThan(guardAt);
    }
  });

  it.each(JOB_FILES)("%s keeps process.exit unreachable from an import", (f) => {
    const src = code(read(f));
    const guardAt = src.indexOf("if (isMainModule) {");
    for (let i = src.indexOf("process.exit("); i !== -1; i = src.indexOf("process.exit(", i + 1)) {
      expect(i, `${f}: process.exit reachable outside the entry guard`).toBeGreaterThan(guardAt);
    }
  });

  it("NO job has a bare module-scope invocation at column 0 — the landmine shape", () => {
    // `\nmain()` with no indentation is exactly how wednesday-drop, monday-movement,
    // sunday-spotlight and thursday-compare all looked before this packet.
    for (const f of JOB_FILES) {
      expect(code(read(f)), f).not.toMatch(/^main\(/m);
    }
  });
});

describe("RUNTIME PIN — importing a module whose main() rejects is inert", () => {
  it("the import executes nothing: no side effect, no exit, no unhandled rejection", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) called at import time`);
    }) as never);

    const mod = await import("./__fixtures__/guarded-job.js");

    expect(mod.sideEffects).toEqual([]);      // main() never ran
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  }, 30000);

  it("THE WORKER SURVIVES — main() rejects into the caller, never into process.exit", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code}) reached — the worker would have died`);
    }) as never);

    const mod = await import("./__fixtures__/guarded-job.js");
    await expect(mod.main()).rejects.toThrow(mod.BOOM);

    expect(mod.sideEffects).toEqual(["main ran"]);   // it really did run and reject
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("…and this case executing at all proves the worker outlived that rejection", () => {
    // If the rejection above had reached process.exit(1), the vitest worker would
    // have died and every file in the run would report "no tests". Reaching this
    // line is the assertion.
    expect(true).toBe(true);
  });
});

describe("the fixture is a faithful stand-in for a real job", () => {
  it("it carries the same hardened guard string the real jobs do", () => {
    const src = code(readFileSync(join(JOBS_DIR, "__tests__", "__fixtures__", "guarded-job.ts"), "utf8"));
    expect(src).toContain(HARDENED);
    expect(src).toContain("if (isMainModule) {");
    // …and its process.exit sits inside that guard, exactly like a real job's.
    expect(src.indexOf("process.exit(")).toBeGreaterThan(src.indexOf("if (isMainModule) {"));
  });
});
