// WD-ENG-13 ITEM 3 (+ a hermeticity guard for ITEM 1b).
//
// ── WHY THE DRY-RUN LINE WAS THE WRONG LEVEL ────────────────────────────────
// friday-archives and saturday-verdict announced "DRY RUN — no delivery" at
// WARN. On an otherwise healthy `--no-deliver` run that was the ONLY yellow line
// in the log — verified against the one real Friday-archives run still on disk,
// whose sole WARN was exactly this. A warning that fires on every healthy run of
// a mode the operator deliberately selected one keystroke ago teaches them that
// yellow on this job means nothing, which is precisely the reflex WD-ENG-05
// diagnosed on the Wikipedia coverage warn.
//
// It is a MODE ANNOUNCEMENT, and the codebase already had the right precedent:
// news-edition and reddit-radar both log their dry-run lines at info. This pins
// all four onto the same footing, and pins that the two demoted lines kept their
// text — the fix was the level, not the message.
//
// Source-level assertions on purpose: these are single log calls buried deep in
// job main()s whose surrounding code fetches, renders and uploads. Driving them
// behaviourally would mean standing up most of a pillar to observe one glyph.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/**
 * The log level of the call that emits `needle`, or null if absent.
 *
 * Anchors on the needle and walks BACK to the nearest preceding `log.X(`. An
 * earlier draft scanned forward from each log call and matched the first whose
 * next 400 chars contained the needle — which happily attributed the line to an
 * unrelated `log.success(` several statements above it. Nearest-preceding is the
 * only reading that cannot straddle another call.
 */
function levelOf(src: string, needle: string): string | null {
  const at = src.indexOf(needle);
  if (at < 0) return null;
  let level: string | null = null;
  for (const m of src.slice(0, at).matchAll(/log\.(info|warn|error|success)\(/g)) {
    level = m[1]!;
  }
  return level;
}

const DRY_RUN_JOBS = [
  ["src/jobs/friday-archives.ts", "DRY RUN — no delivery (--no-deliver): discover + gate + render run"],
  ["src/jobs/saturday-verdict.ts", "DRY RUN — no delivery (--no-deliver): render + score + table run"],
] as const;

describe("a mode announcement is INFO, never WARN", () => {
  it.each(DRY_RUN_JOBS)("%s logs its dry-run line at info", (file, needle) => {
    expect(levelOf(read(file), needle)).toBe("info");
  });

  it("the demoted lines kept their exact text — the LEVEL was the defect", () => {
    // A demotion that also reworded would make it impossible to tell, from a log
    // archive, whether an old line was the same event.
    for (const [file, needle] of DRY_RUN_JOBS) {
      expect(read(file)).toContain(needle);
      expect(read(file)).toContain("--no-deliver");
    }
  });

  it("no job announces a dry run at warn — swept, not spot-checked", () => {
    // Catches a THIRD pillar growing the same habit, which is how this pattern
    // spread to two jobs in the first place.
    const offenders: string[] = [];
    for (const file of [
      "src/jobs/friday-archives.ts",
      "src/jobs/saturday-verdict.ts",
      "src/jobs/news-edition.ts",
      "src/jobs/reddit-radar.ts",
      "src/jobs/wednesday-drop.ts",
      "src/jobs/monday-movement.ts",
      "src/jobs/sunday-spotlight.ts",
      "src/jobs/thursday-compare.ts",
    ]) {
      const src = read(file);
      for (const m of src.matchAll(/log\.warn\(\s*[`"'][^`"']*/g)) {
        if (/DRY RUN|dry run/i.test(m[0])) offenders.push(`${file}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the two jobs that ALREADY used info are unchanged — they are the precedent", () => {
    expect(levelOf(read("src/jobs/news-edition.ts"), "--no-slack: dry run")).toBe("info");
    expect(levelOf(read("src/jobs/reddit-radar.ts"), "--no-slack: dry run")).toBe("info");
  });
});

describe("WD-ENG-13 ITEM 1b — the health ledger never lands in the repo from a test", () => {
  it("no test writes data/source-health.json", () => {
    // The first cut of the ott-calendar pins DID write it, and the streak carried
    // between cases (observed 1 → 2 → 3), which made those assertions depend on
    // their own execution order AND mutated repo state on every suite run. The
    // fix was to stub the recorder in that file; this is the tripwire for the
    // next test that forgets. See also the WD-ENG-10C rule that a test has no
    // business mutating the developer's real data/ state.
    const src = read("src/discovery/__tests__/ott-calendar.test.ts");
    expect(src).toContain('vi.mock("../sources/source-health.js"');
    // …and the ledger's own tests inject a temp path rather than the default.
    const own = read("src/discovery/__tests__/source-health.test.ts");
    expect(own).toContain("mkdtempSync");
    expect(own).not.toMatch(/record(SourceFailure|SourceSuccess)\((\s*)["'][\w-]+["']\s*\)/);
  });
});
