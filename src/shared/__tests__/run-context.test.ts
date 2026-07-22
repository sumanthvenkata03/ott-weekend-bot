// THE WORKING-TREE LAW — may this run publish?
// The decision half is pure, so it is tested without touching git or the repo.
import { describe, it, expect } from "vitest";
import {
  isScheduledRun,
  provenanceLine,
  scheduledRunBlockReason,
  SCHEDULED_ENV,
  type RunContext,
} from "../run-context.js";

const ctx = (p: Partial<RunContext> = {}): RunContext =>
  ({ headSha: "abc1234", dirty: false, scheduled: false, ...p });

describe("isScheduledRun — the scheduler's own flag", () => {
  it("recognises the truthy spellings", () => {
    for (const v of ["1", "true", "TRUE", "yes", " true "]) {
      expect(isScheduledRun({ [SCHEDULED_ENV]: v })).toBe(true);
    }
  });

  it("everything else is a manual run", () => {
    for (const v of [undefined, "", "0", "false", "no", "maybe"]) {
      expect(isScheduledRun(v === undefined ? {} : { [SCHEDULED_ENV]: v })).toBe(false);
    }
  });
});

describe("scheduledRunBlockReason — manual runs are NEVER blocked", () => {
  it("a manual run on a dirty tree proceeds — the operator is present and owns it", () => {
    expect(scheduledRunBlockReason(ctx({ scheduled: false, dirty: true }))).toBeNull();
  });

  it("a manual run with git unreadable proceeds", () => {
    expect(scheduledRunBlockReason(ctx({ scheduled: false, dirty: null }))).toBeNull();
  });
});

describe("scheduledRunBlockReason — scheduled runs FAIL CLOSED", () => {
  it("clean tree ⇒ proceeds", () => {
    expect(scheduledRunBlockReason(ctx({ scheduled: true, dirty: false }))).toBeNull();
  });

  it("DIRTY tree ⇒ refused, and the reason states why it matters", () => {
    const why = scheduledRunBlockReason(ctx({ scheduled: true, dirty: true }));
    expect(why).not.toBeNull();
    expect(why).toContain("DIRTY");
    // The reason must teach the law, not just deny: jobs run the working tree.
    expect(why).toContain("working tree");
  });

  it("UNKNOWN tree ⇒ ALSO refused — an unknown tree is not a clean tree", () => {
    const why = scheduledRunBlockReason(ctx({ scheduled: true, dirty: null }));
    expect(why).not.toBeNull();
    expect(why).toContain("could not read git state");
  });
});

describe("provenanceLine — a published deck is always traceable to code", () => {
  it("carries sha, tree state and run mode", () => {
    expect(provenanceLine(ctx({ headSha: "5c3ccca", dirty: false, scheduled: true })))
      .toBe("5c3ccca · tree clean · scheduled");
  });

  it("names a dirty tree loudly", () => {
    expect(provenanceLine(ctx({ dirty: true }))).toContain("tree DIRTY");
  });

  it("degrades honestly when git is unreadable", () => {
    const line = provenanceLine(ctx({ headSha: "", dirty: null }));
    expect(line).toContain("unknown");
    expect(line).toContain("tree unknown");
  });
});
