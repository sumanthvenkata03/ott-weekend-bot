// WD-ENG-13 ITEM 1b — the consecutive-degradation ledger and its two wordings.
//
// THE POINT OF THE FIX, restated so a future reader does not "simplify" it away:
// discoverOttCalendar printed a line that was byte-identical on run 1 and run 50.
// An operator cannot tell those apart, so they stop reading it — which is how a
// permanently dead source stayed invisible for weeks (WD-ENG-12 found it had
// contributed zero films across five consecutive real runs). The requirement is
// therefore not "a louder line"; it is a line that CHANGES when the situation
// changes, in BOTH directions: escalating when a streak becomes a standing
// condition, and announcing recovery when one ends.
//
// Every case here writes to a per-case temp path. Nothing touches
// data/source-health.json, and nothing touches the network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readSourceHealth,
  recordSourceFailure,
  recordSourceSuccess,
  degradationLine,
  recoveryLine,
  DEAD_SOURCE_THRESHOLD,
  SOURCE_HEALTH_PATH,
} from "../sources/source-health.js";

const SRC = "ott-calendar";
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tbsi-health-"));
  path = join(dir, "source-health.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (iso: string) => new Date(iso);

describe("the ledger counts consecutive failures and persists across processes", () => {
  it("an unknown source reads as healthy, and reading writes nothing", () => {
    expect(readSourceHealth(SRC, path)).toEqual({
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastSuccessAt: null,
    });
    expect(existsSync(path)).toBe(false);
  });

  it("failures accumulate, and the streak start is stamped ONCE", () => {
    const a = recordSourceFailure(SRC, path, at("2026-08-01T00:00:00.000Z"));
    const b = recordSourceFailure(SRC, path, at("2026-08-02T00:00:00.000Z"));
    const c = recordSourceFailure(SRC, path, at("2026-08-03T00:00:00.000Z"));

    expect([a, b, c].map((h) => h.consecutiveFailures)).toEqual([1, 2, 3]);
    // "since when", not "most recently" — all three report the FIRST failure.
    for (const h of [a, b, c]) expect(h.firstFailureAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("the count survives a fresh read — this is what 'across runs' means", () => {
    recordSourceFailure(SRC, path, at("2026-08-01T00:00:00.000Z"));
    recordSourceFailure(SRC, path, at("2026-08-02T00:00:00.000Z"));
    // A separate call with no in-memory state, exactly as the next process does.
    expect(readSourceHealth(SRC, path).consecutiveFailures).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8"))[SRC].consecutiveFailures).toBe(2);
  });

  it("A SUCCESS RESETS THE COUNTER — the requirement, pinned", () => {
    recordSourceFailure(SRC, path, at("2026-08-01T00:00:00.000Z"));
    recordSourceFailure(SRC, path, at("2026-08-02T00:00:00.000Z"));

    const before = recordSourceSuccess(SRC, path, at("2026-08-03T00:00:00.000Z"));

    // The return value is the PRE-reset health, so the caller can say "recovered
    // after N" — after the write that number no longer exists anywhere.
    expect(before.consecutiveFailures).toBe(2);
    expect(readSourceHealth(SRC, path)).toEqual({
      consecutiveFailures: 0,
      firstFailureAt: null,
      lastSuccessAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("a NEW streak after a success starts at 1 and re-stamps its own start", () => {
    recordSourceFailure(SRC, path, at("2026-08-01T00:00:00.000Z"));
    recordSourceSuccess(SRC, path, at("2026-08-02T00:00:00.000Z"));
    const again = recordSourceFailure(SRC, path, at("2026-08-05T00:00:00.000Z"));

    expect(again.consecutiveFailures).toBe(1);
    expect(again.firstFailureAt).toBe("2026-08-05T00:00:00.000Z");
    // The success is remembered even while a new streak runs.
    expect(again.lastSuccessAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("sources are tracked independently — one net's streak is not another's", () => {
    recordSourceFailure("ott-calendar", path, at("2026-08-01T00:00:00.000Z"));
    recordSourceFailure("ott-calendar", path, at("2026-08-02T00:00:00.000Z"));
    recordSourceFailure("ai-ott", path, at("2026-08-02T00:00:00.000Z"));

    expect(readSourceHealth("ott-calendar", path).consecutiveFailures).toBe(2);
    expect(readSourceHealth("ai-ott", path).consecutiveFailures).toBe(1);
  });
});

describe("the ledger can never break a discovery run", () => {
  it("a corrupt file reads as no-history instead of throwing", () => {
    writeFileSync(path, "{ this is not json", "utf8");
    expect(() => readSourceHealth(SRC, path)).not.toThrow();
    expect(readSourceHealth(SRC, path).consecutiveFailures).toBe(0);
  });

  it("a file holding the wrong SHAPE is coerced, not trusted", () => {
    writeFileSync(path, JSON.stringify({ [SRC]: { consecutiveFailures: "lots" } }), "utf8");
    expect(readSourceHealth(SRC, path).consecutiveFailures).toBe(0);

    writeFileSync(path, JSON.stringify([1, 2, 3]), "utf8");
    expect(readSourceHealth(SRC, path).consecutiveFailures).toBe(0);
  });

  it("an unwritable path degrades silently — the run continues", () => {
    // `dir` is an existing DIRECTORY, so writing a file at that exact path
    // cannot succeed (EISDIR). The recorder must swallow it: losing a counter
    // increment is acceptable, losing a discovery run over one is not.
    expect(() => recordSourceFailure(SRC, dir, at("2026-08-01T00:00:00.000Z"))).not.toThrow();
    expect(readSourceHealth(SRC, dir).consecutiveFailures).toBe(0);   // nothing persisted
  });

  it("the production default path is under data/, which is gitignored", () => {
    expect(SOURCE_HEALTH_PATH).toBe("data/source-health.json");
  });
});

describe("THE WORDING CHANGES WHEN THE SITUATION DOES", () => {
  const health = (n: number, first: string | null, last: string | null = null) => ({
    consecutiveFailures: n,
    firstFailureAt: first,
    lastSuccessAt: last,
  });

  it("below the threshold the reason leads and the count is a suffix", () => {
    const line = degradationLine("OTT calendar", "fetch failed — 403", health(1, "2026-08-01T00:00:00.000Z"));
    expect(line).toContain("OTT calendar: fetch failed — 403");
    expect(line).toContain("consecutive failed attempts: 1");
    expect(line).not.toContain("DEAD");
  });

  it("AT the threshold it escalates — this is the line that was missing", () => {
    const line = degradationLine(
      "OTT calendar",
      "fetch failed — 403",
      health(DEAD_SOURCE_THRESHOLD, "2026-08-01T09:00:00.000Z")
    );
    expect(line).toContain("is DEAD, not flaky");
    expect(line).toContain(`${DEAD_SOURCE_THRESHOLD} consecutive failed attempts since 2026-08-01`);
    expect(line).toContain("last success: never recorded");
    // The path-specific reason SURVIVES the escalation — the four failure modes
    // must stay distinguishable in both wordings.
    expect(line).toContain("fetch failed — 403");
  });

  it("the two wordings are genuinely different strings for the same reason", () => {
    const reason = "fetch failed — 403";
    const below = degradationLine("OTT calendar", reason, health(DEAD_SOURCE_THRESHOLD - 1, "2026-08-01T00:00:00.000Z"));
    const above = degradationLine("OTT calendar", reason, health(DEAD_SOURCE_THRESHOLD, "2026-08-01T00:00:00.000Z"));
    expect(below).not.toBe(above);
    // …and it keeps changing after the threshold, so run 50 ≠ run 3.
    const later = degradationLine("OTT calendar", reason, health(50, "2026-08-01T00:00:00.000Z"));
    expect(later).not.toBe(above);
    expect(later).toContain("50 consecutive failed attempts");
  });

  it("a known last-success date is reported instead of 'never'", () => {
    const line = degradationLine(
      "OTT calendar",
      "boom",
      health(5, "2026-08-10T00:00:00.000Z", "2026-07-04T12:00:00.000Z")
    );
    expect(line).toContain("last success: 2026-07-04");
  });

  it("the recovery line names the streak it ended", () => {
    expect(recoveryLine("OTT calendar", health(7, "2026-08-01T00:00:00.000Z")))
      .toMatch(/RECOVERED after 7 consecutive failed attempt\(s\).*2026-08-01/);
  });

  it("the threshold is 3 — a deliberate number, not an accident", () => {
    expect(DEAD_SOURCE_THRESHOLD).toBe(3);
  });
});
