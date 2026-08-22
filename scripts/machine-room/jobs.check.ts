// scripts/machine-room/jobs.check.ts
// THE RUN-MODE CONTRACT. Each job maps to an exact argv, and M1's forced safety
// flag is part of that argv — not a default an operator can drop.
//
// The pins that matter:
//   • the three jobs with NO dry-run mode are the three that demand a typed
//     confirmation, and they are exactly monday/sunday/thursday (verified
//     against the entry files: only saturday and archives parse --no-deliver,
//     only news and radar parse --no-slack);
//   • no argv anywhere contains --approve or a WED_DROP_* dial.

import { describe, it, expect } from "vitest";
import { JOBS, LIVE_CONFIRM_PHRASE, buildArgv, buildCommand, isJobId, type JobId } from "./jobs.js";

const ids = Object.keys(JOBS) as JobId[];

describe("each job builds its EXACT argv", () => {
  const cases: Array<[JobId, string[]]> = [
    ["wednesday", ["tsx", "src/jobs/wednesday-drop.ts"]],
    ["saturday", ["tsx", "src/jobs/saturday-verdict.ts", "--no-deliver"]],
    ["archives", ["tsx", "src/jobs/friday-archives.ts", "--no-deliver"]],
    ["news", ["tsx", "src/jobs/news-edition.ts", "--no-slack"]],
    ["radar", ["tsx", "src/jobs/reddit-radar.ts", "--no-slack"]],
    ["monday", ["tsx", "src/jobs/monday-movement.ts"]],
    ["sunday", ["tsx", "src/jobs/sunday-spotlight.ts"]],
    ["thursday", ["tsx", "src/jobs/thursday-compare.ts"]],
    // MR-M2 NEWS DESK. Three specs, one entry, three LITERAL flags.
    ["news-discover", ["tsx", "src/jobs/news-edition.ts", "--discover"]],
    ["news-generate", ["tsx", "src/jobs/news-edition.ts", "--from-picks"]],
    ["news-mark-posted", ["tsx", "src/jobs/news-edition.ts", "--mark-posted"]],
  ];
  for (const [id, argv] of cases) {
    it(`${id} → npx ${argv.join(" ")}`, () => {
      expect(buildArgv(JOBS[id])).toEqual(argv);
      expect(buildCommand(JOBS[id]).command).toBe("npx");
      expect(buildCommand(JOBS[id]).display).toBe(`npx ${argv.join(" ")}`);
    });
  }
});

describe("forced safety flags", () => {
  it("saturday and archives are --no-deliver", () => {
    expect(JOBS.saturday.flags).toEqual(["--no-deliver"]);
    expect(JOBS.archives.flags).toEqual(["--no-deliver"]);
  });
  it("news and radar are --no-slack", () => {
    expect(JOBS.news.flags).toEqual(["--no-slack"]);
    expect(JOBS.radar.flags).toEqual(["--no-slack"]);
  });
  it("wednesday runs plain — its GATE is the safety", () => {
    expect(JOBS.wednesday.flags).toEqual([]);
    expect(JOBS.wednesday.mode).toBe("gated");
  });
});

describe("jobs with NO dry-run mode demand a typed confirmation", () => {
  it("exactly monday, sunday and thursday", () => {
    const live = ids.filter((i) => JOBS[i].requiresLiveConfirm).sort();
    expect(live).toEqual(["monday", "sunday", "thursday"]);
  });
  it("and they are the only ones in live mode", () => {
    const liveMode = ids.filter((i) => JOBS[i].mode === "live").sort();
    expect(liveMode).toEqual(["monday", "sunday", "thursday"]);
  });
  it("each says plainly that it has no dry run", () => {
    for (const id of ["monday", "sunday", "thursday"] as JobId[]) {
      expect(JOBS[id].willNotSend).toContain("no dry-run mode");
    }
  });
  it("the confirmation phrase is LIVE", () => {
    expect(LIVE_CONFIRM_PHRASE).toBe("LIVE");
  });
});

describe("M1 offers NO dials — the hash-neutral gap stays unarmed", () => {
  it("no argv contains --approve", () => {
    for (const id of ids) expect(buildArgv(JOBS[id]).join(" ")).not.toContain("--approve");
  });
  it("no argv contains a WED_DROP_* dial", () => {
    for (const id of ids) expect(buildArgv(JOBS[id]).join(" ")).not.toContain("WED_DROP");
  });
  it("every entry is a real repo-relative job file", () => {
    for (const id of ids) expect(JOBS[id].entry).toMatch(/^src\/jobs\/[a-z-]+\.ts$/);
  });
});

/**
 * MR-M2's central safety claim, asserted over the WHOLE registry rather than
 * over the three new entries: no argv anywhere contains anything but the entry
 * file and flags that begin with "--". If a pick id, a headline, a filename or
 * any other operator-supplied string ever reached buildArgv, it would have to
 * show up here as a token that is neither.
 */
describe("LITERAL FLAGS ONLY — nothing operator-supplied can reach argv", () => {
  it("every argv is [tsx, <entry>, ...--flags] and nothing else", () => {
    for (const id of ids) {
      const argv = buildArgv(JOBS[id]);
      expect(argv[0], id).toBe("tsx");
      expect(argv[1], id).toBe(JOBS[id].entry);
      for (const flag of argv.slice(2)) {
        expect(flag, `${id} flag ${flag}`).toMatch(/^--[a-z][a-z-]*$/);
      }
    }
  });

  it("no argv token carries a shell metacharacter, a space or a quote", () => {
    for (const id of ids) {
      for (const token of buildArgv(JOBS[id])) {
        expect(token, `${id}: ${token}`).not.toMatch(/[\s&|;<>^"'`$()]/);
      }
    }
  });

  it("the three News Desk specs share one entry and differ ONLY by their flag", () => {
    const desk = ["news-discover", "news-generate", "news-mark-posted"] as JobId[];
    for (const id of desk) {
      expect(JOBS[id].entry).toBe("src/jobs/news-edition.ts");
      expect(JOBS[id].flags).toHaveLength(1);
      expect(JOBS[id].requiresLiveConfirm).toBe(false);
    }
    expect(desk.map((id) => JOBS[id].flags[0])).toEqual(["--discover", "--from-picks", "--mark-posted"]);
  });

  it("every News Desk spec states honestly that nothing goes outward", () => {
    for (const id of ["news-discover", "news-generate", "news-mark-posted"] as JobId[]) {
      expect(JOBS[id].willSend).toBe("nothing outward");
      expect(JOBS[id].willNotSend).toContain("no Slack post");
      expect(JOBS[id].willNotSend).toContain("no R2 upload");
    }
    expect(JOBS["news-discover"].spend).toContain("zero model calls");
    expect(JOBS["news-generate"].spend).toContain("one batched verify call");
    expect(JOBS["news-generate"].spend).toContain("one caption call");
    expect(JOBS["news-mark-posted"].spend).toContain("nothing");
  });

  it("only news-mark-posted claims a ledger write; the other two mark nothing", () => {
    expect(JOBS["news-discover"].willNotSend).toContain("NOTHING is marked seen");
    expect(JOBS["news-generate"].willNotSend).toContain("NOTHING is marked seen");
    expect(JOBS["news-mark-posted"].willNotSend).toContain("seen ledger");
  });
});

describe("isJobId", () => {
  it("accepts every registered id and nothing else", () => {
    for (const id of ids) expect(isJobId(id)).toBe(true);
    for (const junk of ["", "__proto__", "constructor", "wed", 7, null, undefined, "__fake"]) {
      expect(isJobId(junk)).toBe(false);
    }
  });
});
