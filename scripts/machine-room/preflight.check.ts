// scripts/machine-room/preflight.check.ts
// PREFLIGHT CLASSIFIERS + ordering. Every probe is injected, so no claude call,
// no Chromium launch and no spawn happens in this suite.
//
// The point of the ordering assertions: the failure that motivated preflight was
// spending ~3 minutes and ~34 Tavily credits BEFORE discovering `claude` was
// stuck on a workspace-trust dialog. A red disk or a held lock must therefore
// abort before the one billable probe runs — proven here by asserting the
// expensive probes were never CALLED.

import { describe, it, expect } from "vitest";
import {
  classifyAdminToken,
  classifyChromium,
  classifyClaude,
  classifyDisk,
  classifyKeys,
  classifyLock,
  classifyTree,
  runPreflight,
  MIN_FREE_BYTES,
  type ClaudeProbe,
  type PreflightDeps,
} from "./preflight.js";

const okClaude: ClaudeProbe = { kind: "ok", ms: 900 };

function deps(over: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    adminTokenPresent: true,
    keys: { requiredLoaded: true, tavily: true, mdblist: true },
    tree: { provenance: "abc1234 · tree clean · manual", dirty: false },
    lock: { held: false, holder: null, alive: false },
    diskFreeBytes: 50 * 1024 * 1024 * 1024,
    claude: async () => okClaude,
    chromium: async () => ({ ok: true }),
    ...over,
  };
}

describe("claude probe — four outcomes, four different actions", () => {
  it("OK reports the latency", () => {
    const c = classifyClaude({ kind: "ok", ms: 812 });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("812");
  });

  it("ABSENT is red and names the spawn failure", () => {
    const c = classifyClaude({ kind: "absent", message: "spawn claude ENOENT" });
    expect(c.ok).toBe(false);
    expect(c.level).toBe("red");
    expect(c.detail).toContain("ENOENT");
  });

  it("HUNG names the workspace-trust class explicitly — the thing that cost a run", () => {
    const c = classifyClaude({ kind: "hung", ms: 30_000 });
    expect(c.ok).toBe(false);
    expect(c.level).toBe("red");
    expect(c.detail).toContain("workspace-trust");
    expect(c.detail).toContain("30s");
  });

  it("NONZERO includes stderr, SCRUBBED", () => {
    const c = classifyClaude({
      kind: "nonzero",
      code: 1,
      stderr: 'failed calling https://x.test/y?api_key=SUPERSECRETVALUE : 401',
    });
    expect(c.ok).toBe(false);
    expect(c.detail).not.toContain("SUPERSECRETVALUE");
    expect(c.detail).toContain("api_key=***");
  });
});

describe("keys — required is a belt, optionals name their degradation", () => {
  it("both optionals present", () => {
    const cs = classifyKeys({ requiredLoaded: true, tavily: true, mdblist: true });
    expect(cs.every((c) => c.ok)).toBe(true);
  });

  it("TAVILY absent is YELLOW and says the AI net goes empty", () => {
    const c = classifyKeys({ requiredLoaded: true, tavily: false, mdblist: true })[1]!;
    expect(c.ok).toBe(false);
    expect(c.level).toBe("yellow");
    expect(c.detail).toContain("TMDb only");
  });

  it("MDBLIST absent is YELLOW and names the OMDb fallback", () => {
    const c = classifyKeys({ requiredLoaded: true, tavily: true, mdblist: false })[2]!;
    expect(c.ok).toBe(false);
    expect(c.level).toBe("yellow");
    expect(c.detail).toContain("OMDb");
  });

  it("required missing is RED", () => {
    expect(classifyKeys({ requiredLoaded: false, tavily: true, mdblist: true })[0]!.level).toBe("red");
  });
});

describe("tree — dirty is YELLOW, never RED (a manual run is legal)", () => {
  it("clean passes and shows the provenance", () => {
    const c = classifyTree("abc1234 · tree clean · manual", false);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("abc1234");
  });
  it("dirty warns and says the working tree is what publishes", () => {
    const c = classifyTree("abc1234 · tree DIRTY · manual", true);
    expect(c.ok).toBe(false);
    expect(c.level).toBe("yellow");
    expect(c.detail).toContain("WORKING TREE");
  });
  it("unknown git state warns rather than blocking", () => {
    expect(classifyTree("unknown · tree unknown · manual", null).level).toBe("yellow");
  });
});

describe("disk / lock", () => {
  it("under the floor is RED", () => {
    const c = classifyDisk(100 * 1024 * 1024);
    expect(c.ok).toBe(false);
    expect(c.level).toBe("red");
    expect(c.detail).toContain("100 MB");
  });
  it("at the floor passes", () => {
    expect(classifyDisk(MIN_FREE_BYTES).ok).toBe(true);
  });
  it("unmeasurable is YELLOW, not a hard stop", () => {
    expect(classifyDisk(null).level).toBe("yellow");
  });
  it("a LIVE lock holder is RED", () => {
    const c = classifyLock({ held: true, alive: true, holder: { pid: 77, startedAt: "T", jobName: "Wed Drop", argv: [] } });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("77");
  });
  it("a STALE lock passes with a takeover note", () => {
    const c = classifyLock({ held: true, alive: false, holder: { pid: 77, startedAt: "T", jobName: "X", argv: [] } });
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("STALE");
  });
});

describe("chromium / admin token", () => {
  it("launch failure is RED and scrubbed", () => {
    const c = classifyChromium({ ok: false, message: "Failed to launch, token=ABCDEFGHIJK" });
    expect(c.ok).toBe(false);
    expect(c.detail).not.toContain("ABCDEFGHIJK");
  });
  it("missing admin token is RED", () => {
    expect(classifyAdminToken(false).level).toBe("red");
  });
});

describe("the SEQUENCE — cheap first, stop at the first RED, spend nothing after", () => {
  it("a clean run evaluates every check", async () => {
    const r = await runPreflight(deps());
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      "admin token", "required keys", "TAVILY_API_KEY", "MDBLIST_API_KEY",
      "working tree", "disk space", "publish lock", "claude CLI", "Chromium",
    ]);
  });

  it("a RED DISK aborts BEFORE the billable claude probe is ever called", async () => {
    let claudeCalls = 0, chromiumCalls = 0;
    const r = await runPreflight(deps({
      diskFreeBytes: 10 * 1024 * 1024,
      claude: async () => { claudeCalls++; return okClaude; },
      chromium: async () => { chromiumCalls++; return { ok: true }; },
    }));
    expect(r.ok).toBe(false);
    expect(r.stoppedAt).toBe("disk space");
    expect(claudeCalls).toBe(0);
    expect(chromiumCalls).toBe(0);
  });

  it("a HELD lock also aborts before spending", async () => {
    let claudeCalls = 0;
    const r = await runPreflight(deps({
      lock: { held: true, alive: true, holder: { pid: 9, startedAt: "T", jobName: "Wed Drop", argv: [] } },
      claude: async () => { claudeCalls++; return okClaude; },
    }));
    expect(r.stoppedAt).toBe("publish lock");
    expect(claudeCalls).toBe(0);
  });

  it("YELLOWs never stop the sequence", async () => {
    const r = await runPreflight(deps({
      keys: { requiredLoaded: true, tavily: false, mdblist: false },
      tree: { provenance: "abc · tree DIRTY · manual", dirty: true },
    }));
    expect(r.ok).toBe(true);
    expect(r.checks.filter((c) => !c.ok).every((c) => c.level === "yellow")).toBe(true);
  });

  it("a hung claude stops before Chromium is launched", async () => {
    let chromiumCalls = 0;
    const r = await runPreflight(deps({
      claude: async () => ({ kind: "hung", ms: 30_000 }),
      chromium: async () => { chromiumCalls++; return { ok: true }; },
    }));
    expect(r.stoppedAt).toBe("claude CLI");
    expect(chromiumCalls).toBe(0);
  });
});
