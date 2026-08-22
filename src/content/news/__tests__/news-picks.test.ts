// src/content/news/__tests__/news-picks.test.ts
// MR-M2 NEWSDESK - the artifact CONTRACTS. Pure: no network, no model, no db.
//
// Every test here writes into a per-test temp directory, never into the real
// output/machine-room. The `dir` parameter exists for exactly this reason; the
// production callers all take the default, which is the fixed literal path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANDIDATES_FILENAME,
  CANDIDATES_MAX_AGE_HOURS,
  MACHINE_ROOM_DIR,
  PACKAGE_FILENAME,
  PACKAGE_MAX_AGE_HOURS,
  PICKS_FILENAME,
  REDISCOVER_REMEDY,
  REGENERATE_REMEDY,
  NewsCandidatesSchema,
  NewsPackageArtifactSchema,
  NewsPicksSchema,
  buildPackageText,
  candidatesPath,
  checkFreshness,
  packagePath,
  packageStoryUrls,
  picksPath,
  readCandidates,
  readPackage,
  readPicks,
  toCandidateRecord,
  toScoredCluster,
  validatePickedIds,
  writeCandidates,
  writePackage,
  writePicks,
  type NewsCandidates,
  type NewsPackageArtifact,
} from "../news-picks.js";
import type { ScoredCluster } from "../news-score.js";
import type { NewsItem } from "../news-gather.js";
import type { Language } from "../../../shared/types.js";

let DIR = "";
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "tbsi-picks-"));
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function item(url: string, title = "A headline", source = "The Hindu"): NewsItem {
  return { title, url, source, publishedISO: "2026-08-22T04:00:00.000Z", language: "Tamil" as Language };
}

function cluster(over: Partial<ScoredCluster> = {}): ScoredCluster {
  const base: ScoredCluster = {
    id: "c1",
    headline: "Raayan Wins Best Tamil Film at National Awards",
    language: "Tamil" as Language,
    items: [item("https://news.google.com/rss/articles/AAA")],
    outlets: ["The Hindu"],
    outletCount: 1,
    bestTier: "A",
    hasTierC: false,
    storyClass: "awards",
    classWeight: 4,
    suppressed: false,
    tierPoints: 3,
    crossOutletPoints: 0,
    judgedTitle: null,
    judgedPoints: 0,
    score: 7,
    eligible: true,
    holdReason: "",
  };
  return { ...base, ...over };
}

function candidates(over: Partial<NewsCandidates> = {}): NewsCandidates {
  const base: NewsCandidates = {
    generatedAt: "2026-08-22T05:00:00.000Z",
    istDate: "2026-08-22",
    windowHours: 26,
    hiddenSeenCount: 4,
    gatheredCount: 40,
    clusters: [
      toCandidateRecord(cluster({ id: "c1", score: 9 })),
      toCandidateRecord(cluster({ id: "c2", score: 5, headline: "Second story" })),
      toCandidateRecord(
        cluster({
          id: "c3",
          score: 2,
          headline: "Held story",
          eligible: false,
          holdReason: "Tier-C anchor without a Tier-A source",
        })
      ),
    ],
  };
  return { ...base, ...over };
}

describe("the three paths are fixed literals under output/machine-room", () => {
  it("names are exactly what the Machine Room reads", () => {
    expect(CANDIDATES_FILENAME).toBe("news-candidates.json");
    expect(PICKS_FILENAME).toBe("news-picks.json");
    expect(PACKAGE_FILENAME).toBe("news-package.json");
  });

  it("the default directory is repo-root/output/machine-room, not cwd-relative", () => {
    const norm = MACHINE_ROOM_DIR.replace(/\\/g, "/");
    expect(norm.endsWith("/output/machine-room")).toBe(true);
    expect(candidatesPath().replace(/\\/g, "/").endsWith("/output/machine-room/news-candidates.json")).toBe(true);
    expect(picksPath().replace(/\\/g, "/").endsWith("/output/machine-room/news-picks.json")).toBe(true);
    expect(packagePath().replace(/\\/g, "/").endsWith("/output/machine-room/news-package.json")).toBe(true);
  });
});

describe("candidates artifact - schema and round trip", () => {
  it("writes, re-reads and preserves the full cluster payload", () => {
    const c = candidates();
    const path = writeCandidates(c, DIR);
    expect(path).toBe(join(DIR, CANDIDATES_FILENAME));

    const back = readCandidates(DIR);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value).toEqual(c);
  });

  it("carries every field stages 4-8 need, so a resume never re-gathers", () => {
    const rec = toCandidateRecord(cluster());
    // The picker row.
    for (const k of ["id", "headline", "score", "storyClass", "bestTier", "outletCount", "judgedTitle", "eligible", "holdReason"]) {
      expect(rec).toHaveProperty(k);
    }
    // The resume payload: the underlying NewsItems with their urls and outlets.
    expect(rec.cluster.items[0]!.url).toBe("https://news.google.com/rss/articles/AAA");
    expect(rec.cluster.items[0]!.source).toBe("The Hindu");
    expect(rec.cluster.outlets).toEqual(["The Hindu"]);
    expect(toScoredCluster(rec)).toEqual(cluster());
  });

  it("a missing file is a stated refusal, not a throw", () => {
    const r = readCandidates(DIR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("no candidates artifact");
  });

  it("junk JSON and a schema violation both refuse with WHERE", () => {
    writeFileSync(join(DIR, CANDIDATES_FILENAME), "{not json", "utf8");
    const bad = readCandidates(DIR);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("not valid JSON");

    writeFileSync(join(DIR, CANDIDATES_FILENAME), JSON.stringify({ generatedAt: "x" }), "utf8");
    const wrong = readCandidates(DIR);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain("malformed at");
  });

  it("refuses to WRITE an artifact it could not read back", () => {
    expect(() => writeCandidates({ generatedAt: "x" } as unknown as NewsCandidates, DIR)).toThrow();
  });

  it("NewsCandidatesSchema rejects a missing hiddenSeenCount", () => {
    const c = candidates() as Record<string, unknown>;
    delete c.hiddenSeenCount;
    expect(NewsCandidatesSchema.safeParse(c).success).toBe(false);
  });
});

describe("picks artifact", () => {
  it("round trips and requires both fields", () => {
    writePicks({ candidatesGeneratedAt: "2026-08-22T05:00:00.000Z", pickedIds: ["c1", "c2"] }, DIR);
    const back = readPicks(DIR);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value.pickedIds).toEqual(["c1", "c2"]);
    expect(NewsPicksSchema.safeParse({ pickedIds: ["c1"] }).success).toBe(false);
    expect(NewsPicksSchema.safeParse({ candidatesGeneratedAt: "x" }).success).toBe(false);
  });
});

describe("freshness fails CLOSED", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z");

  it("fresh inside the window", () => {
    const v = checkFreshness("2026-08-22T06:00:00.000Z", now, CANDIDATES_MAX_AGE_HOURS, "candidates", REDISCOVER_REMEDY);
    expect(v.fresh).toBe(true);
    expect(v.ageHours).toBeCloseTo(6, 5);
  });

  it("stale past it, and the message says what to do", () => {
    const v = checkFreshness("2026-08-21T20:00:00.000Z", now, CANDIDATES_MAX_AGE_HOURS, "candidates", REDISCOVER_REMEDY);
    expect(v.fresh).toBe(false);
    expect(v.reason).toContain("16.0h old");
    expect(v.reason).toContain("re-discover");
  });

  it("an unreadable generatedAt is STALE - cannot prove fresh means not fresh", () => {
    const v = checkFreshness("not-a-date", now, PACKAGE_MAX_AGE_HOURS, "package", REGENERATE_REMEDY);
    expect(v.fresh).toBe(false);
    expect(v.ageHours).toBeNull();
    expect(v.reason).toContain("unreadable generatedAt");
  });

  it("the two windows are 12h for candidates and 48h for the package", () => {
    expect(CANDIDATES_MAX_AGE_HOURS).toBe(12);
    expect(PACKAGE_MAX_AGE_HOURS).toBe(48);
  });
});

describe("validatePickedIds - the whitelist", () => {
  const c = candidates();

  it("accepts known ids and returns them in ARTIFACT order, not request order", () => {
    const v = validatePickedIds(c, ["c3", "c1"]);
    expect(v.ok).toBe(true);
    expect(v.ids).toEqual(["c1", "c3"]);
  });

  it("dedupes", () => {
    expect(validatePickedIds(c, ["c1", "c1", "c2"]).ids).toEqual(["c1", "c2"]);
  });

  it("REFUSES a bogus id and names it", () => {
    const v = validatePickedIds(c, ["c1", "c99"]);
    expect(v.ok).toBe(false);
    expect(v.unknownIds).toEqual(["c99"]);
    expect(v.reason).toContain("c99");
    expect(v.ids).toEqual([]);
  });

  it("REFUSES ids that are not strings, an empty pick, and a non-array", () => {
    expect(validatePickedIds(c, [1, 2]).ok).toBe(false);
    expect(validatePickedIds(c, []).reason).toContain("at least one");
    expect(validatePickedIds(c, "c1").ok).toBe(false);
    expect(validatePickedIds(c, null).ok).toBe(false);
  });

  it("no lookalike passes - matching is exact equality against the artifact", () => {
    for (const junk of ["C1", "c1 ", " c1", "c1.json", "../c1", "__proto__", "constructor"]) {
      expect(validatePickedIds(c, [junk]).ok, junk).toBe(false);
    }
  });

  it("enforces the cap when the caller supplies one, and ignores it when not", () => {
    expect(validatePickedIds(c, ["c1", "c2", "c3"], 2).ok).toBe(false);
    expect(validatePickedIds(c, ["c1", "c2", "c3"], 2).reason).toContain("at most 2");
    expect(validatePickedIds(c, ["c1", "c2", "c3"]).ok).toBe(true);
  });
});

describe("package artifact + text", () => {
  const story = (over: Partial<NewsPackageArtifact["stories"][number]> = {}) => ({
    id: "c1",
    headline: "Raayan Wins Best Tamil Film",
    badge: "REGISTER",
    segmentReason: "awards -> REGISTER",
    sourceUrl: "https://www.thehindu.com/x",
    score: 9,
    storyClass: "awards",
    operatorOverride: null as string | null,
    itemUrls: ["https://news.google.com/rss/articles/AAA"],
    ...over,
  });

  const pkg = (over: Partial<NewsPackageArtifact> = {}): NewsPackageArtifact => ({
    generatedAt: "2026-08-22T06:00:00.000Z",
    istDate: "2026-08-22",
    format: "register-single",
    why: "REGISTER-SINGLE - 2 renderable stories",
    caption: "The desk's caption.",
    captionHashtags: ["#TamilCinema"],
    commentHashtags: ["#OTT"],
    pinnedComment: "Sources: The Hindu",
    badgeCheckBoard: [{ name: "Raayan", candidateHandle: "@raayan" }],
    heldFor: [],
    overrides: [],
    stories: [story(), story({ id: "c2", headline: "Second", itemUrls: ["https://news.google.com/rss/articles/BBB"] })],
    dropped: [{ headline: "Third", reason: "no receipt" }],
    cardFiles: ["tbsi-news-2026-08-22-card-01.png"],
    packageText: "text",
    ...over,
  });

  it("round trips through the schema", () => {
    const p = pkg();
    writePackage(p, DIR);
    const back = readPackage(DIR);
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.value).toEqual(p);
    expect(NewsPackageArtifactSchema.safeParse(p).success).toBe(true);
  });

  it("packageStoryUrls is EXACTLY the surviving stories' urls, deduped, dropped excluded", () => {
    const p = pkg();
    expect(packageStoryUrls(p)).toEqual([
      "https://news.google.com/rss/articles/AAA",
      "https://news.google.com/rss/articles/BBB",
    ]);
    const dupes = pkg({ stories: [story(), story({ id: "c2" })] });
    expect(packageStoryUrls(dupes)).toEqual(["https://news.google.com/rss/articles/AAA"]);
  });

  it("the package text carries caption, board, pinned comment and the sent-nothing line", () => {
    const p = pkg();
    const t = buildPackageText({ ...p, cardFiles: p.cardFiles });
    expect(t).toContain("The desk's caption.");
    expect(t).toContain("#TamilCinema");
    expect(t).toContain("FIRST COMMENT");
    expect(t).toContain("PINNED COMMENT");
    expect(t).toContain("TAG CHECK");
    expect(t).toContain("@raayan");
    expect(t).toContain("NOTHING WAS SENT");
    expect(t).toContain("tbsi-news-2026-08-22-card-01.png");
  });

  it("an OVERRIDE is rendered LOUDLY - a banner block AND on the story line", () => {
    const p = pkg({
      stories: [story({ operatorOverride: "Tier-C anchor without a Tier-A source" }), story({ id: "c2" })],
    });
    const t = buildPackageText({ ...p, cardFiles: p.cardFiles });
    expect(t).toContain("!! OPERATOR OVERRIDE !!");
    expect(t).toContain("HELD BECAUSE: Tier-C anchor without a Tier-A source");
    expect(t).toContain("!! OPERATOR OVERRIDE - the desk HELD this: Tier-C anchor without a Tier-A source");
    // Twice: once in the banner at the top, once inline on the story. Both are
    // load-bearing - the banner is what you see first, the inline line is what
    // you see when you are checking the story you are about to post.
    expect(t.split("OPERATOR OVERRIDE").length - 1).toBe(2);
  });

  it("no override means no override banner", () => {
    const p = pkg();
    expect(buildPackageText({ ...p, cardFiles: p.cardFiles })).not.toContain("!! OPERATOR OVERRIDE !!");
  });

  it("a HELD caption says so instead of shipping a blank to paste", () => {
    const p = pkg({ heldFor: ["Some Unbacked Name"], caption: "" });
    const t = buildPackageText({ ...p, cardFiles: p.cardFiles });
    expect(t).toContain("CAPTION - HELD");
    expect(t).toContain("Some Unbacked Name");
    expect(t).toContain("Do not post this deck");
  });

  it("the text is ASCII - it gets pasted into terminals and text fields", () => {
    const p = pkg({ stories: [story({ operatorOverride: "held" })] });
    // eslint-disable-next-line no-control-regex
    expect(/^[\x09\x0A\x20-\x7E]*$/.test(buildPackageText({ ...p, cardFiles: p.cardFiles }))).toBe(true);
  });
});

describe("read helpers never touch the real artifact directory in a test", () => {
  it("an empty temp dir reads as absent for all three", () => {
    const empty = mkdtempSync(join(tmpdir(), "tbsi-empty-"));
    mkdirSync(empty, { recursive: true });
    expect(readCandidates(empty).ok).toBe(false);
    expect(readPicks(empty).ok).toBe(false);
    expect(readPackage(empty).ok).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });

  it("writeCandidates creates the directory when it does not exist", () => {
    const nested = join(DIR, "a", "b");
    writeCandidates(candidates(), nested);
    expect(JSON.parse(readFileSync(join(nested, CANDIDATES_FILENAME), "utf8")).istDate).toBe("2026-08-22");
  });
});
