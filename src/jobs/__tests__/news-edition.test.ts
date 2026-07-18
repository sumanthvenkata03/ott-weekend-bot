// NEWS DESK · G — the Slack block packer. Regression cover for a REAL failure:
// the first live send returned 400 Bad Request because a full edition draft
// (~6k chars) was posted as a single section, over Slack's 3000-char limit.
import { describe, it, expect } from "vitest";
import { RICH_STORY_CAP, buildEditionDraft, resolveNewsWebhook, toSectionBlocks } from "../news-edition.js";
import type { ScoredCluster } from "../../content/news/news-score.js";
import type { VerifiedStory } from "../../content/news/news-verify.js";
import type { ComposedEdition } from "../../content/news/news-compose.js";

type Section = { type: string; text: { type: string; text: string } };
const asSections = (b: unknown[]) => b as Section[];

type Block = { type: string; text?: { type: string; text: string }; elements?: { text: string }[] };
const asBlocks = (b: unknown[]) => b as Block[];
/** All rendered text in a banner, whatever block type carried it. */
const allText = (b: unknown[]) =>
  asBlocks(b)
    .map((x) => x.text?.text ?? x.elements?.map((e) => e.text).join(" ") ?? "")
    .join("\n");

const cluster = (id: string, over: Partial<ScoredCluster> = {}): ScoredCluster => ({
  id,
  headline: `headline ${id}`,
  language: "Tamil",
  items: [],
  outlets: ["The Hindu", "Cinema Express"],
  outletCount: 2,
  bestTier: "A",
  hasTierC: false,
  storyClass: "awards",
  classWeight: 4,
  suppressed: false,
  tierPoints: 3,
  crossOutletPoints: 1,
  judgedTitle: null,
  judgedPoints: 0,
  score: 8,
  eligible: true,
  holdReason: "",
  ...over,
});

const confirmedStory = (id: string, over: Partial<ScoredCluster> = {}): VerifiedStory => ({
  cluster: cluster(id, over),
  confirmed: true,
  sourceUrl: `https://www.thehindu.com/${id}`,
  basis: `The Hindu confirms ${id}`,
});

const heldStory = (id: string): VerifiedStory => ({
  cluster: cluster(id),
  confirmed: false,
  sourceUrl: "",
  basis: "no primary outlet page found",
});

const edition = (over: Partial<ComposedEdition> = {}): ComposedEdition => ({
  format: "DIGEST",
  why: "DIGEST — 2 confirmed stories, top score 8.",
  cover: null,
  cards: [],
  ...over,
});

const stats = {
  gathered: 86, fresh: 86, deduped: 86, clusters: 55, eligible: 19, verified: 5, confirmed: 2,
};

const build = (v: VerifiedStory[], inel: ScoredCluster[] = [], e = edition()) =>
  buildEditionDraft("2026-07-18", e, v, inel, "[UNSWEPT DRAFT]\ncaption body", stats);

describe("toSectionBlocks", () => {
  it("keeps a short draft in ONE section", () => {
    const blocks = asSections(toSectionBlocks(["*HEAD*", "a line", "another line"]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("section");
    expect(blocks[0]!.text.type).toBe("mrkdwn");
    expect(blocks[0]!.text.text).toBe("*HEAD*\na line\nanother line");
  });

  it("splits a 6k-char draft so NO section exceeds Slack's limit", () => {
    // The shape that produced the live 400: many medium lines totalling ~6k.
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
    const monster = "z".repeat(7000);
    const blocks = asSections(toSectionBlocks([monster]));
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    expect(blocks.map((b) => b.text.text).join("").replace(/\n/g, "")).toContain("z".repeat(6900));
  });

  it("returns no blocks for no lines", () => {
    expect(toSectionBlocks([])).toEqual([]);
  });
});

describe("resolveNewsWebhook — routing", () => {
  it("prefers the dedicated news webhook", () => {
    expect(resolveNewsWebhook("https://hooks.slack.com/news", "https://hooks.slack.com/main")).toEqual({
      url: "https://hooks.slack.com/news",
      fellBack: false,
    });
  });

  it("FALLS BACK to the main webhook when the news one is unset", () => {
    // A draft must never silently vanish — fellBack drives the logged ℹ line.
    expect(resolveNewsWebhook(undefined, "https://hooks.slack.com/main")).toEqual({
      url: "https://hooks.slack.com/main",
      fellBack: true,
    });
  });

  it("reports the fallback even when BOTH are unset (postToWebhook then no-ops)", () => {
    expect(resolveNewsWebhook(undefined, undefined)).toEqual({ url: undefined, fellBack: true });
  });
});

describe("buildEditionDraft — Block Kit banner", () => {
  it("opens with a header block and an IST context line", () => {
    const { blocks } = build([confirmedStory("a"), confirmedStory("b")]);
    const b = asBlocks(blocks);
    expect(b[0]!.type).toBe("header");
    expect(b[0]!.text!.text).toBe("🗞 THE EVENING EDITION — SHADOW");
    expect(b[1]!.type).toBe("context");
    expect(b[1]!.elements![0]!.text).toContain("2026-07-18");
    expect(b[1]!.elements![0]!.text).toContain("IST");
  });

  it("carries the FORMAT and the composer WHY verbatim", () => {
    const e = edition({ why: "CAROUSEL — 'X' scored 11 (≥ 9 BIG threshold)." });
    const { blocks } = build([confirmedStory("a"), confirmedStory("b")], [], e);
    const text = allText(blocks);
    expect(text).toContain("*FORMAT:* DIGEST");
    expect(text).toContain("CAROUSEL — 'X' scored 11 (≥ 9 BIG threshold).");
  });

  it("renders each confirmed headline as a CLICKABLE link to its receipt", () => {
    const { blocks } = build([confirmedStory("a")]);
    expect(allText(blocks)).toContain("*<https://www.thehindu.com/a|headline a>*");
  });

  it("shows outlet · tier · class · score on each story", () => {
    const text = allText(build([confirmedStory("a")]).blocks);
    expect(text).toContain("The Hindu, Cinema Express · Tier A · awards · score 8");
  });

  it("adds the ★ verdict chip only when the story names a judged film", () => {
    expect(allText(build([confirmedStory("a", { judgedTitle: "Satluj" })]).blocks)).toContain("★ Satluj");
    expect(allText(build([confirmedStory("a")]).blocks)).not.toContain("★");
  });

  it("caps rich stories at RICH_STORY_CAP with a one-line overflow count", () => {
    const many = Array.from({ length: 8 }, (_, i) => confirmedStory(`s${i}`));
    const { blocks } = build(many);
    const text = allText(blocks);
    expect(text).toContain("headline s4");        // 5th rendered
    expect(text).not.toContain("headline s5");    // 6th overflowed
    expect(text).toContain(`…and ${8 - RICH_STORY_CAP} more confirmed stories not shown.`);
  });

  it("lists held stories with their basis lines", () => {
    const { blocks } = build(
      [confirmedStory("a"), confirmedStory("b"), heldStory("h")],
      [cluster("x", { headline: "floored story", eligible: false, holdReason: "below tier floor" })]
    );
    const text = allText(blocks);
    expect(text).toContain("HELD — UNCONFIRMED");
    expect(text).toContain("no primary outlet page found");
    expect(text).toContain("not verified: below tier floor");
  });

  it("keeps the caption fence WHOLE inside a single block", () => {
    // The fence must never straddle a chunk boundary.
    const many = Array.from({ length: 30 }, (_, i) =>
      cluster(`i${i}`, { headline: `floored ${i} ${"q".repeat(120)}`, eligible: false, holdReason: "below tier floor" })
    );
    const { blocks } = build([confirmedStory("a"), confirmedStory("b")], many);
    const fenced = asBlocks(blocks).filter((b) => (b.text?.text ?? "").includes("```"));
    expect(fenced).toHaveLength(1);
    const t = fenced[0]!.text!.text;
    expect((t.match(/```/g) ?? [])).toHaveLength(2); // opened AND closed in the same block
    expect(t).toContain("UNSWEPT DRAFT");
  });

  it("closes with a context footer carrying run stats and thresholds", () => {
    const { blocks } = build([confirmedStory("a"), confirmedStory("b")]);
    const last = asBlocks(blocks).at(-1)!;
    expect(last.type).toBe("context");
    expect(last.elements![0]!.text).toContain("86 gathered");
    expect(last.elements![0]!.text).toContain("thresholds: BIG≥");
  });

  it("uses dividers to separate the banner's regions", () => {
    const { blocks } = build([confirmedStory("a"), confirmedStory("b"), heldStory("h")]);
    expect(asBlocks(blocks).filter((b) => b.type === "divider").length).toBeGreaterThanOrEqual(3);
  });

  it("never emits a section over Slack's 3000-char limit", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      cluster(`i${i}`, { headline: `floored ${i} ${"w".repeat(150)}`, eligible: false, holdReason: "below tier floor" })
    );
    const { blocks } = build([confirmedStory("a"), confirmedStory("b")], many);
    for (const b of asBlocks(blocks)) {
      if (b.text?.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("still labels the fallback text SHADOW", () => {
    expect(build([confirmedStory("a")]).text).toContain("SHADOW");
  });
});
