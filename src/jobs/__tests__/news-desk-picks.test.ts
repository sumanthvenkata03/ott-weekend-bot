// src/jobs/__tests__/news-desk-picks.test.ts
// MR-M2 NEWSDESK - the three interactive entries: --discover, --from-picks,
// --mark-posted.
//
// HERMETIC BY CONSTRUCTION. Every expensive or outward-facing collaborator is
// either an injected dep (gather, verify, resolve, caption, render) or a mocked
// module (the seen ledger, Slack, R2, the deck zip). Nothing here touches a
// feed, a model, sqlite, R2 or a webhook, and the "nothing outward" pins are
// asserted against the SAME mocks the run would have used if it tried.
//
// composeEdition and the segment table are deliberately NOT mocked: the format
// decision over an operator-picked subset is exactly what these tests exist to
// establish.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const seenMock = vi.hoisted(() => ({
  alreadySeen: vi.fn((_url: string) => false),
  markSeen: vi.fn(),
  markAllSeen: vi.fn(),
  normalizeUrl: (u: string) => u,
  itemKey: (u: string) => u,
}));
const slackMock = vi.hoisted(() => ({
  postToWebhook: vi.fn(async () => undefined),
  notifyDraftReady: vi.fn(async () => undefined),
  notifyJobFailure: vi.fn(async () => undefined),
  buildJobFailureBlocks: vi.fn(() => []),
}));
const r2Mock = vi.hoisted(() => ({
  uploadPngToR2: vi.fn(async () => ({ publicUrl: "https://example.invalid/x.png", r2Key: "x" })),
  uploadPngsToR2: vi.fn(async () => []),
  uploadBufferToR2: vi.fn(async () => ({ publicUrl: "", r2Key: "" })),
  uploadFileToR2: vi.fn(async () => ({ publicUrl: "", r2Key: "" })),
  deleteFromR2: vi.fn(async () => undefined),
}));
const zipMock = vi.hoisted(() => ({
  buildAndUploadDeckZip: vi.fn(async () => ({ url: "https://example.invalid/x.zip", key: "x", bytes: 0, files: [] })),
  writeCaptionFile: vi.fn(async () => undefined),
  writeKitFile: vi.fn(async () => undefined),
}));

vi.mock("../../content/news/news-seen.js", () => seenMock);
vi.mock("../../delivery/slack.js", () => slackMock);
vi.mock("../../delivery/r2-upload.js", () => r2Mock);
vi.mock("../../delivery/deliver-deck-zip.js", () => zipMock);

import {
  MAX_PICKS,
  runDiscover,
  runFromPicks,
  runMarkPosted,
  type DiscoverDeps,
  type FromPicksDeps,
} from "../news-edition.js";
import {
  CANDIDATES_FILENAME,
  PACKAGE_FILENAME,
  NewsCandidatesSchema,
  NewsPackageArtifactSchema,
  readPackage,
  toCandidateRecord,
  writeCandidates,
  writePackage,
  writePicks,
  type NewsCandidates,
  type NewsPackageArtifact,
} from "../../content/news/news-picks.js";
import type { NewsItem } from "../../content/news/news-gather.js";
import type { ScoredCluster } from "../../content/news/news-score.js";
import type { VerifiedStory } from "../../content/news/news-verify.js";
import type { ResolvedStory } from "../../content/news/news-resolve.js";
import type { NewsPackage } from "../../content/news/news-caption.js";
import type { Language } from "../../shared/types.js";

const NOW = Date.parse("2026-08-22T06:00:00.000Z");

let DIR = "";
beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), "tbsi-desk-"));
  vi.clearAllMocks();
  seenMock.alreadySeen.mockImplementation(() => false);
});
afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

// -- fixtures ---------------------------------------------------------------

function item(url: string, title: string, source = "The Hindu"): NewsItem {
  return { title, url, source, publishedISO: "2026-08-22T04:00:00.000Z", language: "Tamil" as Language };
}

function cluster(over: Partial<ScoredCluster> = {}): ScoredCluster {
  const base: ScoredCluster = {
    id: "c1",
    headline: "Balan The Boy Locks Its OTT Release Date",
    language: "Tamil" as Language,
    items: [item("https://news.google.com/rss/articles/AAA", "Balan The Boy Locks Its OTT Release Date")],
    outlets: ["The Hindu"],
    outletCount: 1,
    bestTier: "A",
    hasTierC: false,
    storyClass: "ott-date",
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

const HELD_REASON = "Tier-C anchor without a Tier-A source";

function threeCandidates(generatedAt = "2026-08-22T05:00:00.000Z"): NewsCandidates {
  return {
    generatedAt,
    istDate: "2026-08-22",
    windowHours: 26,
    hiddenSeenCount: 2,
    gatheredCount: 9,
    clusters: [
      toCandidateRecord(cluster({ id: "c1", score: 8 })),
      toCandidateRecord(
        cluster({
          id: "c2",
          score: 6,
          headline: "Aandhi Streaming Date Confirmed For Next Friday",
          items: [item("https://news.google.com/rss/articles/BBB", "Aandhi Streaming Date Confirmed For Next Friday", "Indian Express")],
          outlets: ["Indian Express"],
        })
      ),
      toCandidateRecord(
        cluster({
          id: "c3",
          score: 1,
          headline: "Kaadhal Enbadhu Gets A Surprise Digital Premiere",
          items: [item("https://news.google.com/rss/articles/CCC", "Kaadhal Enbadhu Gets A Surprise Digital Premiere", "Filmibeat")],
          outlets: ["Filmibeat"],
          bestTier: "C",
          hasTierC: true,
          tierPoints: -3,
          eligible: false,
          holdReason: HELD_REASON,
        })
      ),
    ],
  };
}

function verifiedFor(c: ScoredCluster, confirmed: boolean, basis = "confirmed by The Hindu"): VerifiedStory {
  return {
    cluster: c,
    confirmed,
    sourceUrl: confirmed ? `https://www.thehindu.com/${c.id}` : "",
    basis,
    films: [],
  };
}

function resolvedFor(v: VerifiedStory): ResolvedStory {
  return { story: v, film: null, films: [], reason: `${v.cluster.id}: typographic` };
}

const STUB_PACKAGE: NewsPackage = {
  caption: "Two dates, one Friday.",
  cardCopy: {},
  captionHashtags: ["#TamilCinema"],
  commentHashtags: ["#OTT"],
  badgeCheckBoard: [],
  pinnedComment: "Sources: The Hindu",
  heldFor: [],
};

function picksDeps(over: Partial<FromPicksDeps> = {}): FromPicksDeps {
  return {
    loadJudged: () => [],
    verify: vi.fn(async (cs: ScoredCluster[]) => cs.map((c) => verifiedFor(c, true))),
    resolve: vi.fn(async (confirmed: VerifiedStory[]) => confirmed.map(resolvedFor)),
    buildPkg: vi.fn(async () => STUB_PACKAGE),
    // No coverPath: exactOptionalPropertyTypes means an explicit `undefined` is
    // not the same as an absent optional field. A register-single renders one
    // card and no cover, which is exactly this shape.
    render: vi.fn(async () => ({
      cardPaths: ["output/posts/tbsi-news-2026-08-22-card-01.png"],
      notes: ["typographic"],
    })),
    shutdownBrowser: vi.fn(async () => undefined),
    ...over,
  };
}

function seedFresh(generatedAt = "2026-08-22T05:00:00.000Z", ids: string[] = ["c1", "c2"]): NewsCandidates {
  const c = threeCandidates(generatedAt);
  writeCandidates(c, DIR);
  writePicks({ candidatesGeneratedAt: generatedAt, pickedIds: ids }, DIR);
  return c;
}

// ===========================================================================
// PART 1 - DISCOVER
// ===========================================================================

describe("--discover writes a candidates artifact and nothing else", () => {
  const gathered: NewsItem[] = [
    item("https://news.google.com/rss/articles/AAA", "Balan The Boy Locks Its OTT Release Date"),
    item("https://news.google.com/rss/articles/BBB", "Aandhi Streaming Date Confirmed For Next Friday"),
    item("https://news.google.com/rss/articles/SEEN1", "Old Story One Already Reported"),
    item("https://news.google.com/rss/articles/SEEN2", "Old Story Two Already Reported"),
  ];

  const deps = (): DiscoverDeps => ({
    gather: vi.fn(async () => gathered),
    isSeen: (url: string) => url.includes("SEEN"),
    loadJudged: () => [],
  });

  it("the artifact validates, and carries the run's identity", async () => {
    const art = await runDiscover(NOW, deps(), DIR);
    expect(NewsCandidatesSchema.safeParse(art).success).toBe(true);
    expect(art.istDate).toBe("2026-08-22");
    expect(art.windowHours).toBe(26);
    expect(art.gatheredCount).toBe(4);
    expect(art.generatedAt).toBe(new Date(NOW).toISOString());

    const onDisk = JSON.parse(readFileSync(join(DIR, CANDIDATES_FILENAME), "utf8"));
    expect(NewsCandidatesSchema.safeParse(onDisk).success).toBe(true);
  });

  it("hiddenSeenCount MATCHES the filter, and the hidden items are absent", async () => {
    const art = await runDiscover(NOW, deps(), DIR);
    expect(art.hiddenSeenCount).toBe(2);
    const urls = art.clusters.flatMap((c) => c.cluster.items.map((i) => i.url));
    expect(urls.some((u) => u.includes("SEEN"))).toBe(false);
    expect(urls).toHaveLength(2);
  });

  it("writes NO seen entries - the ledger is read, never touched", async () => {
    await runDiscover(NOW, deps(), DIR);
    expect(seenMock.markAllSeen).not.toHaveBeenCalled();
    expect(seenMock.markSeen).not.toHaveBeenCalled();
  });

  it("sends nothing outward and calls no model", async () => {
    await runDiscover(NOW, deps(), DIR);
    expect(slackMock.postToWebhook).not.toHaveBeenCalled();
    expect(r2Mock.uploadPngToR2).not.toHaveBeenCalled();
    expect(zipMock.buildAndUploadDeckZip).not.toHaveBeenCalled();
  });

  it("every cluster row carries what the picker renders AND what a resume needs", async () => {
    const art = await runDiscover(NOW, deps(), DIR);
    for (const row of art.clusters) {
      expect(typeof row.id).toBe("string");
      expect(typeof row.headline).toBe("string");
      expect(typeof row.score).toBe("number");
      expect(typeof row.storyClass).toBe("string");
      expect(["A", "B", "C"]).toContain(row.bestTier);
      expect(typeof row.outletCount).toBe("number");
      expect(typeof row.eligible).toBe("boolean");
      expect(typeof row.holdReason).toBe("string");
      expect(row.cluster.items.length).toBeGreaterThan(0);
      expect(row.cluster.items[0]!.url).toBeTruthy();
      expect(row.cluster.items[0]!.source).toBeTruthy();
    }
  });

  it("a quiet gather still writes a valid, empty artifact", async () => {
    const art = await runDiscover(NOW, { gather: async () => [], isSeen: () => false, loadJudged: () => [] }, DIR);
    expect(art.clusters).toEqual([]);
    expect(art.hiddenSeenCount).toBe(0);
    expect(NewsCandidatesSchema.safeParse(art).success).toBe(true);
  });
});

// ===========================================================================
// PART 2 - GENERATE FROM PICKS
// ===========================================================================

describe("--from-picks REFUSES rather than guesses", () => {
  it("no picks file", async () => {
    writeCandidates(threeCandidates(), DIR);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/no picks artifact/);
  });

  it("no candidates file", async () => {
    writePicks({ candidatesGeneratedAt: "2026-08-22T05:00:00.000Z", pickedIds: ["c1"] }, DIR);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/no candidates artifact/);
  });

  it("a BOGUS id, named in the refusal", async () => {
    const c = threeCandidates();
    writeCandidates(c, DIR);
    writePicks({ candidatesGeneratedAt: c.generatedAt, pickedIds: ["c1", "c99"] }, DIR);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/c99/);
  });

  it("a generatedAt MISMATCH between the picks and the artifact", async () => {
    const c = threeCandidates();
    writeCandidates(c, DIR);
    writePicks({ candidatesGeneratedAt: "2026-08-21T05:00:00.000Z", pickedIds: ["c1"] }, DIR);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/re-discover/);
  });

  it("a STALE artifact - older than 12h - and the message says re-discover", async () => {
    const stale = "2026-08-21T12:00:00.000Z"; // 18h before NOW
    seedFresh(stale, ["c1"]);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/18\.0h old/);
    await expect(runFromPicks(NOW, picksDeps(), DIR)).rejects.toThrow(/re-discover/);
  });

  it("a refusal spends NOTHING - verify is never called", async () => {
    const deps = picksDeps();
    writeCandidates(threeCandidates(), DIR);
    await expect(runFromPicks(NOW, deps, DIR)).rejects.toThrow();
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.render).not.toHaveBeenCalled();
  });
});

describe("--from-picks bills over the PICKS only", () => {
  it("verify is called ONCE, with exactly the picked clusters, in artifact order", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c2", "c1"]);
    const deps = picksDeps();
    await runFromPicks(NOW, deps, DIR);

    expect(deps.verify).toHaveBeenCalledTimes(1);
    const [clusters, istDate] = (deps.verify as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((clusters as ScoredCluster[]).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(istDate).toBe("2026-08-22");
    // c3 was never picked, so it never reached a verification slot.
    expect((clusters as ScoredCluster[]).some((c) => c.id === "c3")).toBe(false);
  });

  it("a pick set larger than the cap reports the overflow loudly instead of hiding it", async () => {
    const c = threeCandidates();
    const many = {
      ...c,
      clusters: [
        ...c.clusters,
        ...[4, 5, 6, 7].map((n) =>
          toCandidateRecord(
            cluster({
              id: `c${n}`,
              score: 3,
              headline: `Filler story number ${n} gets a streaming slot`,
              items: [item(`https://news.google.com/rss/articles/F${n}`, `Filler story number ${n}`)],
            })
          )
        ),
      ],
    };
    writeCandidates(many, DIR);
    const all = many.clusters.map((x) => x.id);
    writePicks({ candidatesGeneratedAt: many.generatedAt, pickedIds: all }, DIR);

    const deps = picksDeps();
    const art = await runFromPicks(NOW, deps, DIR);
    const [clusters] = (deps.verify as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((clusters as ScoredCluster[])).toHaveLength(MAX_PICKS);
    const overCap = art.dropped.filter((d) => d.reason.includes("verification cap"));
    expect(overCap).toHaveLength(all.length - MAX_PICKS);
  });
});

describe("--from-picks and the OPERATOR OVERRIDE", () => {
  it("a held-but-picked story proceeds TAGGED, and the package text shouts it", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c3"]);
    const art = await runFromPicks(NOW, picksDeps(), DIR);

    const overridden = art.stories.find((s) => s.id === "c3");
    expect(overridden?.operatorOverride).toBe(HELD_REASON);
    expect(art.overrides.map((o) => o.id)).toEqual(["c3"]);
    expect(art.packageText).toContain("!! OPERATOR OVERRIDE !!");
    expect(art.packageText).toContain(HELD_REASON);

    // The story that was NOT held carries no tag.
    expect(art.stories.find((s) => s.id === "c1")?.operatorOverride).toBeNull();
  });

  it("an override NEVER bypasses verification - an unconfirmed pick drops with its reason", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c3"]);
    const deps = picksDeps({
      verify: vi.fn(async (cs: ScoredCluster[]) =>
        cs.map((c) => (c.id === "c3" ? verifiedFor(c, false, "no primary outlet page found") : verifiedFor(c, true)))
      ),
    });
    const art = await runFromPicks(NOW, deps, DIR);

    // The held story reached verify like any other...
    const [clusters] = (deps.verify as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((clusters as ScoredCluster[]).map((c) => c.id)).toEqual(["c1", "c3"]);
    // ...and was dropped, with BOTH the verifier's reason and the desk's hold.
    expect(art.stories.some((s) => s.id === "c3")).toBe(false);
    const drop = art.dropped.find((d) => d.headline.includes("Kaadhal"));
    expect(drop?.reason).toContain("did NOT bypass verification");
    expect(drop?.reason).toContain("no primary outlet page found");
    expect(drop?.reason).toContain(HELD_REASON);
    expect(art.overrides).toEqual([]);
  });
});

describe("--from-picks composes, renders and writes the package", () => {
  it("two picks compose a register-single and the artifact validates", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c2"]);
    const deps = picksDeps();
    const art = await runFromPicks(NOW, deps, DIR);

    expect(art.format).toBe("register-single");
    expect(art.stories.map((s) => s.id)).toEqual(["c1", "c2"]);
    expect(art.stories[0]!.badge).toBe("TBSI RADAR");
    expect(art.stories[0]!.sourceUrl).toBe("https://www.thehindu.com/c1");
    expect(art.cardFiles).toEqual(["tbsi-news-2026-08-22-card-01.png"]);
    expect(NewsPackageArtifactSchema.safeParse(art).success).toBe(true);

    const onDisk = readPackage(DIR);
    expect(onDisk.ok).toBe(true);
    if (onDisk.ok) expect(onDisk.value).toEqual(art);
  });

  it("each package story carries the item URLs --mark-posted will use", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c2"]);
    const art = await runFromPicks(NOW, picksDeps(), DIR);
    expect(art.stories.find((s) => s.id === "c1")!.itemUrls).toEqual(["https://news.google.com/rss/articles/AAA"]);
    expect(art.stories.find((s) => s.id === "c2")!.itemUrls).toEqual(["https://news.google.com/rss/articles/BBB"]);
  });

  it("A SINGLE-STORY PICK composes without throwing - and honestly reports 'none'", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1"]);
    const deps = picksDeps();
    const art = await runFromPicks(NOW, deps, DIR);

    // MIN_STORIES_FOR_EDITION is 2 (law N4). One confirmed story is not an
    // edition, and the artifact says so rather than rendering a lone card.
    expect(art.format).toBe("none");
    expect(art.why).toContain("No edition today");
    expect(art.stories).toEqual([]);
    expect(art.cardFiles).toEqual([]);
    expect(deps.render).not.toHaveBeenCalled();
    expect(NewsPackageArtifactSchema.safeParse(art).success).toBe(true);
  });

  it("marks NOTHING seen", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c2"]);
    await runFromPicks(NOW, picksDeps(), DIR);
    expect(seenMock.markAllSeen).not.toHaveBeenCalled();
    expect(seenMock.markSeen).not.toHaveBeenCalled();
  });

  it("sends NOTHING outward - no Slack, no R2, no zip", async () => {
    seedFresh("2026-08-22T05:00:00.000Z", ["c1", "c2"]);
    await runFromPicks(NOW, picksDeps(), DIR);
    expect(slackMock.postToWebhook).not.toHaveBeenCalled();
    expect(r2Mock.uploadPngToR2).not.toHaveBeenCalled();
    expect(r2Mock.uploadPngsToR2).not.toHaveBeenCalled();
    expect(zipMock.buildAndUploadDeckZip).not.toHaveBeenCalled();
    expect(zipMock.writeCaptionFile).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PART 3 - MARK AS POSTED
// ===========================================================================

function packageArtifact(over: Partial<NewsPackageArtifact> = {}): NewsPackageArtifact {
  return {
    generatedAt: "2026-08-22T05:30:00.000Z",
    istDate: "2026-08-22",
    format: "register-single",
    why: "two stories",
    caption: "caption",
    captionHashtags: ["#TamilCinema"],
    commentHashtags: [],
    pinnedComment: "",
    badgeCheckBoard: [],
    heldFor: [],
    overrides: [],
    stories: [
      {
        id: "c1",
        headline: "Kept one",
        badge: "TBSI RADAR",
        segmentReason: "r",
        sourceUrl: "https://www.thehindu.com/c1",
        score: 8,
        storyClass: "ott-date",
        operatorOverride: null,
        itemUrls: ["https://news.google.com/rss/articles/AAA", "https://news.google.com/rss/articles/AAA2"],
      },
      {
        id: "c2",
        headline: "Kept two",
        badge: "TBSI RADAR",
        segmentReason: "r",
        sourceUrl: "https://www.thehindu.com/c2",
        score: 6,
        storyClass: "ott-date",
        operatorOverride: null,
        itemUrls: ["https://news.google.com/rss/articles/BBB"],
      },
    ],
    dropped: [{ headline: "Dropped one", reason: "no receipt" }],
    cardFiles: ["tbsi-news-2026-08-22-card-01.png"],
    packageText: "text",
    ...over,
  };
}

describe("--mark-posted marks EXACTLY the package's story URLs", () => {
  it("marks every kept story's item URLs and prints the count", async () => {
    writePackage(packageArtifact(), DIR);
    const out = await runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR);
    expect(out.marked).toBe(3);
    expect(seenMock.markAllSeen).toHaveBeenCalledTimes(1);
    expect(seenMock.markAllSeen.mock.calls[0]![0]).toEqual([
      "https://news.google.com/rss/articles/AAA",
      "https://news.google.com/rss/articles/AAA2",
      "https://news.google.com/rss/articles/BBB",
    ]);
  });

  it("a DROPPED story's URLs are NOT marked", async () => {
    writePackage(
      packageArtifact({
        dropped: [{ headline: "Dropped one", reason: "no receipt" }],
      }),
      DIR
    );
    const out = await runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR);
    // The dropped story never appears in `stories`, so it contributes no URL.
    expect(out.urls.some((u) => u.includes("DROPPED"))).toBe(false);
    expect(out.urls).toHaveLength(3);
  });

  it("REFUSES when the package artifact is missing", async () => {
    await expect(runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR)).rejects.toThrow(/no package artifact/);
    expect(seenMock.markAllSeen).not.toHaveBeenCalled();
  });

  it("REFUSES a package older than 48h", async () => {
    writePackage(packageArtifact({ generatedAt: "2026-08-19T06:00:00.000Z" }), DIR);
    await expect(runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR)).rejects.toThrow(/72\.0h old/);
    expect(seenMock.markAllSeen).not.toHaveBeenCalled();
  });

  it("REFUSES a malformed package artifact", async () => {
    rmSync(join(DIR, PACKAGE_FILENAME), { force: true });
    writeCandidates(threeCandidates(), DIR);
    await expect(runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR)).rejects.toThrow(/no package artifact/);
  });

  it("is IDEMPOTENT - a double run marks the same URL set, never a different one", async () => {
    writePackage(packageArtifact(), DIR);
    const first = await runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR);
    const second = await runMarkPosted(NOW + 60_000, { markAll: seenMock.markAllSeen }, DIR);
    expect(second.urls).toEqual(first.urls);
    expect(seenMock.markAllSeen).toHaveBeenCalledTimes(2);
    expect(seenMock.markAllSeen.mock.calls[1]![0]).toEqual(seenMock.markAllSeen.mock.calls[0]![0]);
  });

  it("sends nothing outward", async () => {
    writePackage(packageArtifact(), DIR);
    await runMarkPosted(NOW, { markAll: seenMock.markAllSeen }, DIR);
    expect(slackMock.postToWebhook).not.toHaveBeenCalled();
    expect(r2Mock.uploadPngToR2).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// THE SCHEDULED PATH IS UNTOUCHED
// ===========================================================================

describe("SOURCE PIN - the scheduled news path is unchanged", () => {
  const SRC = readFileSync(new URL("../news-edition.ts", import.meta.url), "utf8");
  // Indentation moved by two spaces when the branch gained an `else`; the
  // TOKENS are what carry behaviour, so they are what is pinned.
  const flat = SRC.replace(/\s+/g, " ");

  it("mode selection for bare / --now / --test-banner is the original expression", () => {
    expect(flat).toContain(
      'const mode: RunMode = args.includes("--test-banner") ? "test" : args.includes("--now") ? "now" : "scheduled";'
        .replace(/\s+/g, " ")
    );
  });

  it("main() is still invoked exactly once, with the original argument", () => {
    expect(SRC.match(/\bmain\(\{/g) ?? []).toHaveLength(1);
    expect(flat).toContain('main({ slack: !args.includes("--no-slack"), mode })');
  });

  it("the three new flags exist ONLY in the new dispatch, never inside main()", () => {
    const mainBody = SRC.slice(SRC.indexOf("async function main("), SRC.indexOf("// ====="));
    for (const flag of ["--discover", "--from-picks", "--mark-posted"]) {
      expect(mainBody.includes(flag), flag).toBe(false);
      expect(SRC.includes(`args.includes("${flag}")`), flag).toBe(true);
    }
  });

  it("nothing in the --from-picks path can reach Slack, R2 or the zip", () => {
    const from = SRC.slice(SRC.indexOf("export async function runFromPicks"), SRC.indexOf("export interface MarkPostedDeps"));
    for (const outward of ["postToWebhook", "uploadPngToR2", "buildAndUploadDeckZip", "writeCaptionFile", "markAllSeen", "markSeen"]) {
      expect(from.includes(outward), outward).toBe(false);
    }
  });

  it("nothing in the --discover path can mark seen", () => {
    const disc = SRC.slice(SRC.indexOf("export async function runDiscover"), SRC.indexOf("export interface FromPicksDeps"));
    expect(disc.includes("markAllSeen")).toBe(false);
    expect(disc.includes("markSeen")).toBe(false);
  });
});
