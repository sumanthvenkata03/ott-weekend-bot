// scripts/machine-room/verdict.check.ts
// THE SELF-CONTRADICTING VERDICT, pinned shut.
//
// The screenshot that started M1.2 showed these two lines stacked on top of
// each other after an Archives dry run:
//
//     NO ARTIFACTS for this date — the run stopped before it produced anything
//     5 of 7 PNG(s) written by THIS run
//
// Both from the same object. The verdict assumed a Wednesday shape — "no
// manifest ⇒ nothing happened" — and Archives never writes a manifest (there
// is no saveManifest call in src/jobs/friday-archives.ts at all). So the only
// class it CAN produce was the class the verdict ignored.
//
// PURE: counts in, wording out. No filesystem.

import { describe, it, expect } from "vitest";
import { JOB_ARTIFACTS, classifyRun } from "./job-artifacts.js";
import type { JobId } from "./jobs.js";

const none = { manifests: 0, results: 0, pngs: 0 };

describe("THE FOUNDING FIXTURE — Archives dry run", () => {
  const v = classifyRun("archives", { ...none, pngs: 5 });

  it("reads as a SUCCESS, not an absence", () => {
    expect(v.kind).toBe("as-expected");
    expect(v.text).toContain("DRY RUN");
    expect(v.text).toContain("5 PNG(s) rendered");
    expect(v.text).toContain("nothing delivered");
  });

  it("never claims nothing was produced — the exact contradiction from the screenshot", () => {
    expect(v.text).not.toContain("NO ARTIFACTS");
    expect(v.text).not.toContain("PRODUCED NOTHING");
    expect(v.text).not.toMatch(/stopped before it produced anything/);
  });

  it("does NOT treat the missing manifest as a fault — Archives writes none", () => {
    expect(v.missing).toEqual([]);
    expect(JOB_ARTIFACTS.archives.expects).toEqual(["pngs"]);
    expect(JOB_ARTIFACTS.archives.expects).not.toContain("manifests");
  });

  it("and a dry run with NO cards is honestly negative", () => {
    const empty = classifyRun("archives", none);
    expect(empty.kind).toBe("produced-nothing");
    expect(empty.text).toContain("PRODUCED NOTHING");
    expect(empty.missing).toEqual(["pngs"]);
  });
});

describe("Wednesday — the gate is a correct outcome, not a failure", () => {
  it("results but no cards reads as REVIEW ONLY", () => {
    const v = classifyRun("wednesday", { ...none, results: 2 });
    expect(v.kind).toBe("review-only");
    expect(v.text).toContain("REVIEW ONLY");
    expect(v.text).toContain("GATE");
    expect(v.text).toContain("normal outcome");
    expect(v.missing).toEqual([]);
  });

  it("a full publication reads as COMPLETE with the counts", () => {
    const v = classifyRun("wednesday", { manifests: 2, results: 2, pngs: 9 });
    expect(v.kind).toBe("as-expected");
    expect(v.text).toContain("COMPLETE");
    expect(v.text).toContain("9 PNG(s)");
  });

  it("nothing at all is a genuine PRODUCED NOTHING", () => {
    const v = classifyRun("wednesday", none);
    expect(v.kind).toBe("produced-nothing");
    expect(v.missing).toEqual(["results"]);
  });
});

describe("Radar / Thursday — jobs that write nothing by design", () => {
  it("radar producing nothing is CLEAN, not a failure", () => {
    const v = classifyRun("radar", none);
    expect(v.kind).toBe("nothing-expected");
    expect(v.text).toContain("COMPLETE");
    expect(v.text).toContain("correct outcome");
    expect(v.text).not.toContain("PRODUCED NOTHING");
  });

  it("thursday likewise", () => {
    expect(classifyRun("thursday", none).kind).toBe("nothing-expected");
  });
});

describe("News — a quiet day is legitimately empty", () => {
  it("nothing rendered says so WITHOUT calling it a fault", () => {
    const v = classifyRun("news", none);
    expect(v.kind).toBe("nothing-expected");
    expect(v.text).toContain("can be normal");
    expect(v.text).toContain("quiet news day");
  });
  it("cards rendered reads as a dry run success", () => {
    const v = classifyRun("news", { ...none, pngs: 4 });
    expect(v.kind).toBe("as-expected");
    expect(v.text).toContain("4 PNG(s) rendered");
  });
});

describe("PARTIAL — produced some of what it should, not all", () => {
  it("saturday with cards but no manifest names what is missing", () => {
    const v = classifyRun("saturday", { ...none, pngs: 5 });
    expect(v.kind).toBe("partial");
    expect(v.text).toContain("PARTIAL");
    expect(v.text).toContain("a manifest");
    expect(v.missing).toEqual(["manifests"]);
  });

  it("saturday with both is a clean dry run", () => {
    const v = classifyRun("saturday", { ...none, manifests: 1, pngs: 5 });
    expect(v.kind).toBe("as-expected");
    expect(v.text).toContain("DRY RUN");
    expect(v.text).toContain("no R2 upload");
  });

  it("monday/sunday are live, so they say COMPLETE rather than DRY RUN", () => {
    for (const j of ["monday", "sunday"] as JobId[]) {
      const v = classifyRun(j, { ...none, manifests: 1, pngs: 3 });
      expect(v.text).toContain("COMPLETE");
      expect(v.text).not.toContain("DRY RUN");
    }
  });
});

describe("the registry matches what the jobs actually do", () => {
  it("only news, radar, thursday and the three News Desk steps can legitimately produce nothing", () => {
    const normal = (Object.keys(JOB_ARTIFACTS) as JobId[]).filter((j) => JOB_ARTIFACTS[j].emptyIsNormal);
    // MR-M2 added three. news-discover and news-mark-posted write to
    // output/machine-room/, which is not an artifact class this registry
    // observes; news-generate can legitimately render nothing when the picked
    // stories fail verification or fall under law N4.
    expect(normal.sort()).toEqual([
      "news",
      "news-discover",
      "news-generate",
      "news-mark-posted",
      "radar",
      "thursday",
    ]);
  });

  it("radar and thursday render no PNGs, so they carry no prefix", () => {
    expect(JOB_ARTIFACTS.radar.pngPrefix).toBeNull();
    expect(JOB_ARTIFACTS.thursday.pngPrefix).toBeNull();
  });

  it("every rendering job's prefix matches its renderer's filenames", () => {
    expect(JOB_ARTIFACTS.wednesday.pngPrefix).toBe("wed-drop-");
    expect(JOB_ARTIFACTS.saturday.pngPrefix).toBe("sat-verdict-");
    expect(JOB_ARTIFACTS.archives.pngPrefix).toBe("tbsi-archives-");
    expect(JOB_ARTIFACTS.news.pngPrefix).toBe("tbsi-news-");
    expect(JOB_ARTIFACTS.monday.pngPrefix).toBe("mon-movement-");
    expect(JOB_ARTIFACTS.sunday.pngPrefix).toBe("sun-spotlight-");
  });

  it("the forced dry-run jobs are saturday, archives, news, radar + the two read-only News Desk steps", () => {
    const dry = (Object.keys(JOB_ARTIFACTS) as JobId[]).filter((j) => JOB_ARTIFACTS[j].dryRun);
    // news-mark-posted is deliberately NOT here: writing the seen ledger is the
    // whole point of that step, so calling it a dry run would be a lie.
    expect(dry.sort()).toEqual([
      "archives",
      "news",
      "news-discover",
      "news-generate",
      "radar",
      "saturday",
    ]);
    expect(JOB_ARTIFACTS["news-mark-posted"].dryRun).toBe(false);
  });
});
