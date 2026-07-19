// NEWS DESK · G (Phase 2) — Slack block packing + routing + the package banner.
// The chunker cover is regression for a REAL failure: the first live Phase-1
// send returned 400 because a ~6k-char draft went out as one section.
import { describe, it, expect } from "vitest";
import { buildPackageMessage, resolveNewsWebhook, toSectionBlocks, type PackageDelivery } from "../news-edition.js";
import type { ComposedEdition, SelectedStory } from "../../content/news/news-compose.js";
import type { NewsPackage } from "../../content/news/news-caption.js";
import type { ScoredCluster } from "../../content/news/news-score.js";
import { SEGMENTS } from "../../content/news/segments.js";

type Section = { type: string; text: { type: string; text: string } };
type Block = { type: string; text?: { type: string; text: string }; elements?: { text: string }[] };
const asSections = (b: unknown[]) => b as Section[];
const asBlocks = (b: unknown[]) => b as Block[];
const allText = (b: unknown[]) =>
  asBlocks(b).map((x) => x.text?.text ?? x.elements?.map((e) => e.text).join(" ") ?? "").join("\n");

describe("toSectionBlocks", () => {
  it("keeps a short message in ONE section", () => {
    const blocks = asSections(toSectionBlocks(["*HEAD*", "a line"]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text.text).toBe("*HEAD*\na line");
  });

  it("splits a 6k-char body so NO section exceeds Slack's limit", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `• story ${i} ${"x".repeat(90)}`);
    const blocks = asSections(toSectionBlocks(lines));
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });

  it("never drops content when splitting", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}-${"y".repeat(100)}`);
    const joined = asSections(toSectionBlocks(lines)).map((b) => b.text.text).join("\n");
    for (const l of lines) expect(joined).toContain(l);
  });

  it("hard-splits a single oversized line rather than dropping it", () => {
    const blocks = asSections(toSectionBlocks(["z".repeat(7000)]));
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });

  it("returns no blocks for no lines", () => {
    expect(toSectionBlocks([])).toEqual([]);
  });
});

describe("resolveNewsWebhook — routing", () => {
  it("prefers the dedicated news webhook", () => {
    expect(resolveNewsWebhook("https://hooks.slack.com/news", "https://hooks.slack.com/main"))
      .toEqual({ url: "https://hooks.slack.com/news", fellBack: false });
  });

  it("FALLS BACK to the main webhook when the news one is unset", () => {
    expect(resolveNewsWebhook(undefined, "https://hooks.slack.com/main"))
      .toEqual({ url: "https://hooks.slack.com/main", fellBack: true });
  });

  it("reports the fallback even when BOTH are unset", () => {
    expect(resolveNewsWebhook(undefined, undefined)).toEqual({ url: undefined, fellBack: true });
  });
});

// ── package banner ──────────────────────────────────────────────────────────

const cluster = (over: Partial<ScoredCluster> = {}): ScoredCluster => ({
  id: "c1", headline: "Balan The Boy locks its ZEE5 date", language: "Malayalam",
  items: [], outlets: ["The Hindu", "Republic World"], outletCount: 2, bestTier: "A",
  hasTierC: false, storyClass: "ott-date", classWeight: 4, suppressed: false,
  tierPoints: 3, crossOutletPoints: 1, judgedTitle: null, judgedPoints: 0, score: 8,
  eligible: true, holdReason: "", ...over,
});

const sel = (over: Partial<ScoredCluster> = {}, poster = false): SelectedStory => ({
  resolved: {
    story: { cluster: cluster(over), confirmed: true, sourceUrl: "https://thehindu.com/x", basis: "confirmed" },
    film: poster
      ? { title: "Balan The Boy", confidence: "quoted", tmdbId: 42, posterUrl: "https://image.tmdb.org/p.jpg" }
      : null,
    reason: "r",
  },
  segment: SEGMENTS.RADAR,
  segmentReason: "class=ott-date → TBSI RADAR",
});

const edition = (over: Partial<ComposedEdition> = {}): ComposedEdition => ({
  format: "register-single",
  why: "REGISTER-SINGLE — 2 renderable stories.",
  cover: null,
  cards: [sel(), sel({ headline: "Another story", id: "c2" })],
  dropped: [],
  ...over,
});

const pkg = (over: Partial<NewsPackage> = {}): NewsPackage => ({
  caption: "𝗕𝗼𝗹𝗱 headline\nBody per The Hindu.",
  captionHashtags: ["#TBSI", "#IndianCinema"],
  commentHashtags: ["#OTT", "#MovieNews"],
  badgeCheckBoard: [{ name: "Chidambaram", candidateHandle: "@chidambaram" }],
  pinnedComment: "Sources: The Hindu — https://thehindu.com/x",
  heldFor: [],
  ...over,
});

const stats = {
  gathered: 86, deduped: 86, clusters: 55, eligible: 19,
  verified: 5, confirmed: 4, resolved: 2, rendered: 1,
};

const build = (
  e = edition(),
  p = pkg(),
  d: PackageDelivery = { previewUrls: ["https://r2/card-01.png"], zipUrl: "https://r2/deck.zip" }
) => buildPackageMessage("2026-07-19", e, p, d, [], [], stats, true);

describe("buildPackageMessage", () => {
  it("opens with the NEWS DESK header — 'Evening Edition' is gone", () => {
    const { blocks } = build();
    const b = asBlocks(blocks);
    expect(b[0]!.type).toBe("header");
    expect(b[0]!.text!.text).toContain("TBSI NEWS DESK — today's suggestions");
    expect(allText(blocks)).not.toMatch(/evening edition/i);
  });

  it("marks a TEST run in the header", () => {
    expect(asBlocks(build().blocks)[0]!.text!.text).toContain("🧪 TEST");
  });

  it("carries the format and the composer WHY verbatim", () => {
    const e = edition({ why: "JN-SKIN — scored 11 (≥ 9)." });
    const text = allText(build(e).blocks);
    expect(text).toContain("JN-SKIN — scored 11 (≥ 9).");
  });

  it("prints a SEGMENT badge on every story line", () => {
    expect(allText(build().blocks)).toContain("TBSI RADAR");
  });

  it("links each headline to its receipt", () => {
    expect(allText(build().blocks)).toContain("*<https://thehindu.com/x|Balan The Boy locks its ZEE5 date>*");
  });

  it("reports poster vs typographic art per story", () => {
    const withArt = edition({ cards: [sel({}, true), sel({ id: "c2", headline: "Other" })] });
    const t = allText(build(withArt).blocks);
    expect(t).toContain("art: poster (quoted)");
    expect(t).toContain("art: typographic");
  });

  it("includes card previews and the zip link", () => {
    const t = allText(build().blocks);
    expect(t).toContain("https://r2/card-01.png");
    expect(t).toContain("download deck .zip");
  });

  it("says so when a single card ships without a zip", () => {
    const t = allText(build(edition(), pkg(), { previewUrls: ["https://r2/a.png"] }).blocks);
    expect(t).toContain("single card — no zip");
  });

  it("puts the caption in a copy fence, whole, in ONE block", () => {
    const fenced = asBlocks(build().blocks).filter((b) => (b.text?.text ?? "").includes("```"));
    expect(fenced.length).toBeGreaterThanOrEqual(1);
    const caption = fenced.find((f) => f.text!.text.includes("𝗕𝗼𝗹𝗱"))!;
    expect((caption.text!.text.match(/```/g) ?? [])).toHaveLength(2);
  });

  it("splits hashtags — caption set vs first comment", () => {
    const t = allText(build().blocks);
    expect(t).toContain("#TBSI #IndianCinema");
    expect(t).toContain("first comment:");
  });

  it("shows the badge-check board and never claims a verified tag", () => {
    const t = allText(build().blocks);
    expect(t).toContain("BADGE CHECK");
    expect(t).toContain("No tick, no tag");
    expect(t).toContain("Chidambaram");
  });

  it("reports a HELD caption instead of shipping unbacked names", () => {
    const t = allText(build(edition(), pkg({ heldFor: ["Rajinikanth"], caption: "(held)" })).blocks);
    expect(t).toContain("CAPTION — HELD");
    expect(t).toContain("Rajinikanth");
  });

  it("lists selection drops with their reasons", () => {
    const e = edition({ dropped: [{ headline: "'Lenin' OTT release date confirmed", reason: "duplicate of \"'Lenin' OTT release\"" }] });
    const t = allText(build(e).blocks);
    expect(t).toContain("HELD");
    expect(t).toContain("duplicate of");
  });

  it("closes with a context footer carrying run stats and thresholds", () => {
    const last = asBlocks(build().blocks).at(-1)!;
    expect(last.type).toBe("context");
    expect(last.elements![0]!.text).toContain("86 gathered");
    expect(last.elements![0]!.text).toContain("thresholds: BIG≥");
  });

  it("never emits a section over Slack's 3000-char limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => sel({ id: `c${i}`, headline: `story ${i} ${"w".repeat(120)}` }));
    const { blocks } = build(edition({ cards: many }));
    for (const b of asBlocks(blocks)) {
      if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});
