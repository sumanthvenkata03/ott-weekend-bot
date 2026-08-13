// WIRING PINS — source-level invariants the type system cannot express.
//
// These read the real source files, the way the template lint does. They exist
// because the guarantees below are about WHERE a call is made, not about its
// types — and a types-only check would pass while the guarantee quietly died.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
/** Drop // line comments and /* block *​/ comments so prose can't satisfy a pin. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("CALLER PIN — skipCountryGate has exactly ONE caller", () => {
  // The country gate is a safety feature. skipCountryGate exists only because
  // AI-net films are ALREADY gated at seam (b); no other path carries that
  // guarantee, so no other path may pass it. If a second caller ever appears,
  // this fails and the reviewer has to justify it.
  const files = [
    "src/jobs/wednesday-drop.ts",
    "src/jobs/monday-movement.ts",
    "src/jobs/saturday-verdict.ts",
    "src/jobs/sunday-spotlight.ts",
    "src/jobs/friday-archives.ts",
    "src/jobs/thursday-compare.ts",
    "src/discovery/candidates.ts",
    "src/content/archives/archives-discover.ts",
    "src/reconcile/cli.ts",
    "src/index.ts",
  ];

  it("only wednesday-drop.ts passes skipCountryGate", () => {
    const callers = files.filter((f) => code(read(f)).includes("skipCountryGate"));
    expect(callers).toEqual(["src/jobs/wednesday-drop.ts"]);
  });

  it("it is passed exactly once, from the AI-net enrichment helper", () => {
    const src = code(read("src/jobs/wednesday-drop.ts"));
    expect(src.split("skipCountryGate").length - 1).toBe(1);
    // …and that occurrence sits inside enrichAiNetFilms, not anywhere else.
    const helper = src.slice(src.indexOf("export async function enrichAiNetFilms"));
    const nextFn = helper.indexOf("async function produceEdition");
    expect(helper.slice(0, nextFn)).toContain("skipCountryGate");
  });

  it("every other enrichReleases call site enriches WITH the gate", () => {
    for (const f of files.filter((x) => x !== "src/jobs/wednesday-drop.ts")) {
      const src = code(read(f));
      if (!src.includes("enrichReleases(")) continue;
      expect(src, f).not.toContain("skipCountryGate");
    }
  });
});

describe("WIRING PIN — the three checkpoints are all present and ordered", () => {
  const src = code(read("src/jobs/wednesday-drop.ts"));

  it("checkpoint 1 (decideGate) runs before checkpoint 2 (confirmAutoPublish)", () => {
    // produceEdition is DEFINED above main(), so compare against the call site.
    expect(src).toContain("decideGate(results");
    expect(src).toContain("confirmAutoPublish(manifest)");
  });

  it("checkpoint 2 precedes the render call inside produceEdition", () => {
    const body = src.slice(src.indexOf("async function produceEdition"));
    expect(body.indexOf("confirmAutoPublish(manifest)")).toBeLessThan(body.indexOf("await renderWedDrop("));
  });

  it("checkpoint 3 (auditRender) precedes the R2 upload", () => {
    const body = src.slice(src.indexOf("async function produceEdition"));
    expect(body.indexOf("auditRender({")).toBeLessThan(body.indexOf("uploadPngsToR2("));
  });

  it("the working-tree preflight runs before any spend", () => {
    const body = src.slice(src.indexOf("async function main()"));
    expect(body.indexOf("assertPublishableTree()")).toBeLessThan(body.indexOf("verifyCandidates"));
  });

  it("run artifacts are persisted BEFORE the checkpoints that may block", () => {
    const body = src.slice(src.indexOf("async function produceEdition"));
    expect(body.indexOf('"draft"')).toBeLessThan(body.indexOf("confirmAutoPublish(manifest)"));
  });
});

describe("WIRING PIN — the contract is actually invoked for both card types", () => {
  const src = code(read("src/jobs/wednesday-drop.ts"));

  it("buildManifest receives the wed-drop cardType and an editionDate", () => {
    expect(src).toContain('cardType: "wed-drop"');
    expect(src).toContain("editionDate: dateStr");
  });

  it("the why-line reaches the contract per film", () => {
    expect(src).toContain("whyLine");
    expect(src).toContain("whyByTitle");
  });

  it("manifest provenance (headSha / treeDirty) is recorded", () => {
    expect(src).toContain("headSha: runCtx.headSha");
    expect(src).toContain("treeDirty: runCtx.dirty");
  });

  it("produceEdition is called for BOTH editions with the run context", () => {
    expect(src).toContain('produceEdition("theatrical"');
    expect(src).toContain('produceEdition("ott"');
    expect(src.split("runCtx, { mode: decision.mode, hash: decision.hash }").length - 1).toBe(2);
  });
});

describe("WIRING PIN — HARD_FAIL_ON_INVALID stays false (R1)", () => {
  it("the flag is unchanged; the gate consumes the manifest instead", () => {
    // The contract must not start throwing mid-run. Blocking is the gate's job.
    expect(code(read("src/shared/post-validator.ts"))).toContain("HARD_FAIL_ON_INVALID = false");
  });
});

// WD-ENG-02 — the anchored number must actually REACH every consumer. The type
// system cannot express "this value came from the anchor and not from the clock",
// and a single stray getIssueNumberForToday() inside produceEdition would restore
// the bug invisibly. So the threading is pinned at source.
describe("WIRING PIN — the issue number is anchored, then threaded", () => {
  const src = code(read("src/jobs/wednesday-drop.ts"));

  it("resolved from the anchor, and the wall-clock helper is gone from this job", () => {
    expect(src).toContain("resolveIssueNumber(");
    expect(src).not.toContain("getIssueNumberForToday");
  });

  it("resolution happens AFTER decideGate — the hash is its key, so it cannot precede it", () => {
    const gateAt = src.indexOf("const decision = decideGate(");
    const anchorAt = src.indexOf("resolveIssueNumber({");
    expect(gateAt).toBeGreaterThan(-1);
    expect(anchorAt).toBeGreaterThan(gateAt);
  });

  it("resolution happens BEFORE the blocked-run return — the gate run must leave the anchor", () => {
    const anchorAt = src.indexOf("resolveIssueNumber({");
    const blockedAt = src.indexOf("if (!decision.proceed)");
    expect(blockedAt).toBeGreaterThan(anchorAt);
  });

  it("it is keyed by the gate hash and knows whether this run is an --approve", () => {
    const call = src.slice(src.indexOf("resolveIssueNumber({"), src.indexOf("const issueNumber = issueAnchor"));
    expect(call).toContain("hash: decision.hash");
    expect(call).toContain("isApprove: approveHash !== undefined");
  });

  it("ONE value flows to every consumer — render, ledger, dedup, manifest, run-complete", () => {
    expect(src).toContain("const issueNumber = issueAnchor.issueNumber;");
    // The four consumers the packet names, plus the manifest receipt.
    expect(src).toContain("renderWedDrop(draft, issueNumber, edition,");
    expect(src).toContain("recordFeatured(draft.releases, pillarKey, issueNumber)");
    expect(src).toContain("excludedKeysFor(pillarKey, { excludeIssue: issueNumber })");
    expect(src).toContain("buildManifest(`Wed Drop · ${meta.slackLabel}`, issueNumber,");
    expect(src).toContain("Wed Drop run complete (Issue №${issueNumber})");
  });

  it("produceEdition takes the number as a PARAMETER — it never recomputes one", () => {
    // Boundaries must be CODE, not comments: `code()` strips comments, so a
    // comment endpoint yields indexOf -1 and slices to end-of-file.
    const from = src.indexOf("async function produceEdition(");
    const to = src.indexOf("function parseApproveArg(");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const fn = src.slice(from, to);
    expect(fn).toContain("issueNumber: string,");
    expect(fn).not.toContain("getIssueNumber");
    expect(fn).not.toContain("resolveIssueNumber");
  });
});

// WD-ENG-01 PART 4 — "small, unconditional, EVERY job entry point that renders
// or delivers". That is a statement about where a call sits, which is exactly
// what a wiring pin is for: a types-only check would pass while a job quietly
// stopped persisting its own log.
describe("WIRING PIN — every job entry point starts a run log", () => {
  const JOBS = [
    "src/jobs/wednesday-drop.ts",
    "src/jobs/monday-movement.ts",
    "src/jobs/saturday-verdict.ts",
    "src/jobs/sunday-spotlight.ts",
    "src/jobs/friday-archives.ts",
    "src/jobs/thursday-compare.ts",
    "src/jobs/news-edition.ts",
    "src/jobs/reddit-radar.ts",
  ];

  it.each(JOBS)("%s calls startRunLog", (f) => {
    expect(code(read(f))).toContain("startRunLog(");
  });

  it("the call is INSIDE main(), not at module scope (importing a job must log nothing)", () => {
    for (const f of JOBS) {
      const src = code(read(f));
      const mainAt = src.search(/async function main\s*\(/);
      expect(mainAt, f).toBeGreaterThan(-1);
      // Every occurrence sits after main()'s declaration — a module-scope call
      // would fire on import, and news-edition imports reddit-radar.
      for (let i = src.indexOf("startRunLog("); i !== -1; i = src.indexOf("startRunLog(", i + 1)) {
        if (src.slice(i - 30, i).includes("import")) continue;   // the import line
        expect(i, `${f}: startRunLog outside main()`).toBeGreaterThan(mainAt);
      }
    }
  });

  it("it is unconditional — no env flag guards it", () => {
    for (const f of JOBS) {
      const src = code(read(f));
      const line = src.split("\n").find((l) => l.includes("startRunLog(") && !l.includes("import"))!;
      expect(line, f).not.toContain("if ");
      expect(line, f).not.toContain("process.env");
    }
  });
});
