// NEWS DESK · G (Phase 2) — Slack block packing + routing + the package banner.
// The chunker cover is regression for a REAL failure: the first live Phase-1
// send returned 400 because a ~6k-char draft went out as one section.
import { describe, it, expect } from "vitest";
import { MAX_INLINE_IMAGES, SLACK_BLOCK_CEILING, buildPackageMessage, capBlocks, headerFor, isEphemeral, istClockTime, resolveNewsWebhook, toSectionBlocks, zipCaptionText, type PackageDelivery } from "../news-edition.js";
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
    story: { cluster: cluster(over), confirmed: true, sourceUrl: "https://thehindu.com/x", basis: "confirmed", films: [] },
    film: poster
      ? { title: "Balan The Boy", confidence: "quoted", tmdbId: 42, posterUrl: "https://image.tmdb.org/p.jpg" }
      : null,
    films: poster
      ? [{ title: "Balan The Boy", confidence: "quoted", tmdbId: 42, posterUrl: "https://image.tmdb.org/p.jpg" }]
      : [],
    reason: "r",
  },
  segment: SEGMENTS.RADAR,
  segmentReason: "class=ott-date → TBSI RADAR",
});

const edition = (over: Partial<ComposedEdition> = {}): ComposedEdition => ({
  format: "register-single",
  explodeFilms: false,
  why: "REGISTER-SINGLE — 2 renderable stories.",
  cover: null,
  cards: [sel(), sel({ headline: "Another story", id: "c2" })],
  dropped: [],
  ...over,
});

const pkg = (over: Partial<NewsPackage> = {}): NewsPackage => ({
  caption: "𝗕𝗼𝗹𝗱 headline\nBody per The Hindu.",
  cardCopy: { c1: { cardLine: "Balan The Boy Locks Its Streaming Date", cardDek: "The thriller arrives on ZEE5." } },
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
) => buildPackageMessage("2026-07-19", e, p, d, [], [], stats, "test", "18:42");

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

  it("includes card previews (now INLINE images) and the zip link", () => {
    const { blocks } = build();
    // Post-first layout: previews are image blocks, so the URL lives in
    // image_url rather than in any section's text.
    const imgs = (blocks as { type: string; image_url?: string }[]).filter((b) => b.type === "image");
    expect(imgs.map((b) => b.image_url)).toContain("https://r2/card-01.png");
    expect(allText(blocks)).toContain("download deck .zip");
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

  it("splits hashtags — caption set vs its own FIRST COMMENT step", () => {
    const t = allText(build().blocks);
    expect(t).toContain("#TBSI #IndianCinema");   // step 2, inside the caption fence
    expect(t).toContain("3️⃣ FIRST COMMENT");      // step 3, its own fence
    expect(t).toContain("#OTT #MovieNews");
  });

  it("shows the tag-check board and never claims a verified tag", () => {
    const t = allText(build().blocks);
    expect(t).toContain("5️⃣ TAG CHECK");
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

describe("zipCaptionText — the deck zip is self-contained", () => {
  it("embeds the REAL caption, not a pointer at Slack", () => {
    const t = zipCaptionText(pkg());
    expect(t).toContain("𝗕𝗼𝗹𝗱 headline");
    expect(t).toContain("Body per The Hindu.");
    expect(t.toLowerCase()).not.toContain("see slack");
  });

  it("carries both hashtag sets, labelled", () => {
    const t = zipCaptionText(pkg());
    expect(t).toContain("#TBSI #IndianCinema");
    expect(t).toContain("— FIRST COMMENT —");
    expect(t).toContain("#OTT #MovieNews");
  });

  it("carries the pinned comment", () => {
    const t = zipCaptionText(pkg());
    expect(t).toContain("— PINNED COMMENT —");
    expect(t).toContain("https://thehindu.com/x");
  });

  it("a HELD caption ships a refusal, never a blank to paste by accident", () => {
    const t = zipCaptionText(pkg({ heldFor: ["Rajinikanth"], caption: "" }));
    expect(t).toContain("CAPTION HELD");
    expect(t).toContain("Rajinikanth");
    expect(t).toContain("Do not post this deck");
  });

  it("omits the first-comment block when there are no overflow hashtags", () => {
    const t = zipCaptionText(pkg({ commentHashtags: [] }));
    expect(t).not.toContain("— FIRST COMMENT —");
  });
});

describe("run modes — scheduled / --now / --test-banner", () => {
  it("only the scheduled run is non-ephemeral", () => {
    expect(isEphemeral("scheduled")).toBe(false);
    expect(isEphemeral("now")).toBe(true);
    expect(isEphemeral("test")).toBe(true);
  });

  it("--now header is a REAL surface — no TEST label, carries the IST clock", () => {
    const h = headerFor("now", "18:42");
    expect(h).toBe("🗞 TBSI NEWS DESK — on-demand · 18:42 IST");
    expect(h).not.toContain("TEST");
  });

  it("--test-banner header keeps the TEST label", () => {
    expect(headerFor("test", "18:42")).toContain("🧪 TEST");
  });

  it("the scheduled header is unchanged", () => {
    expect(headerFor("scheduled", "07:00")).toBe("🗞 TBSI NEWS DESK — today's suggestions");
  });

  it("istClockTime renders IST (UTC+5:30) as zero-padded HH:mm", () => {
    expect(istClockTime(new Date("2026-07-19T13:12:00Z"))).toBe("18:42");
    expect(istClockTime(new Date("2026-07-19T01:00:00Z"))).toBe("06:30");
    // Crosses midnight IST correctly.
    expect(istClockTime(new Date("2026-07-19T19:00:00Z"))).toBe("00:30");
  });

  it("an on-demand package banner shows the on-demand header", () => {
    const { blocks } = buildPackageMessage(
      "2026-07-19", edition(), pkg(),
      { previewUrls: [] }, [], [], stats, "now", "18:42"
    );
    expect(asBlocks(blocks)[0]!.text!.text).toContain("on-demand · 18:42 IST");
  });
});

// ── MICRO 3: inline images + post-first checklist ──────────────────────────

const withImages = (n: number, zip = true): PackageDelivery => ({
  previewUrls: Array.from({ length: n }, (_, i) => `https://r2.example/img-${i}.png`),
  ...(zip ? { zipUrl: "https://r2.example/deck.zip" } : {}),
});
const buildD = (d: PackageDelivery) =>
  buildPackageMessage("2026-07-19", edition(), pkg(), d, [], [], stats, "now", "18:42");
type ImageBlock = { type: string; image_url?: string; alt_text?: string };

describe("inline card images", () => {
  it("renders each card as a Block Kit image block", () => {
    const imgs = (buildD(withImages(3)).blocks as ImageBlock[]).filter((b) => b.type === "image");
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.image_url).toBe("https://r2.example/img-0.png");
  });

  it("labels the first image 'cover' and the rest 'card NN'", () => {
    const imgs = (buildD(withImages(3)).blocks as ImageBlock[]).filter((b) => b.type === "image");
    expect(imgs[0]!.alt_text).toBe("cover");
    expect(imgs[1]!.alt_text).toBe("card 01");
    expect(imgs[2]!.alt_text).toBe("card 02");
  });

  it("a lone image is a card, not a cover", () => {
    const imgs = (buildD(withImages(1)).blocks as ImageBlock[]).filter((b) => b.type === "image");
    expect(imgs[0]!.alt_text).toBe("card 00");
  });

  it("every image block carries a non-empty alt_text (Slack rejects blank)", () => {
    for (const b of (buildD(withImages(4)).blocks as ImageBlock[]).filter((x) => x.type === "image")) {
      expect(b.alt_text!.length).toBeGreaterThan(0);
    }
  });

  it("CAPS inline images and links the overflow with a count", () => {
    const { blocks } = buildD(withImages(8));
    expect((blocks as ImageBlock[]).filter((b) => b.type === "image")).toHaveLength(MAX_INLINE_IMAGES);
    const t = allText(blocks);
    expect(t).toContain(`(+${8 - MAX_INLINE_IMAGES} more in the zip)`);
    expect(t).toContain("https://r2.example/img-5.png");
  });

  it("keeps the zip as a LINK line — a zip cannot be inlined", () => {
    const t = allText(buildD(withImages(2)).blocks);
    expect(t).toContain("download deck .zip");
    const imgs = (buildD(withImages(2)).blocks as ImageBlock[]).filter((b) => b.type === "image");
    expect(imgs.every((b) => !b.image_url!.endsWith(".zip"))).toBe(true);
  });

  it("says so when there is no zip", () => {
    expect(allText(buildD(withImages(1, false)).blocks)).toContain("single card — no zip");
  });
});

describe("post-first checklist layout", () => {
  it("orders the five steps 1-5", () => {
    const t = allText(buildD(withImages(2)).blocks);
    const order = ["1️⃣ IMAGES", "2️⃣ CAPTION", "3️⃣ FIRST COMMENT", "4️⃣ PINNED COMMENT", "5️⃣ TAG CHECK"];
    let last = -1;
    for (const step of order) {
      const at = t.indexOf(step);
      expect(at, `${step} missing`).toBeGreaterThan(-1);
      expect(at, `${step} out of order`).toBeGreaterThan(last);
      last = at;
    }
  });

  it("puts the whole checklist ABOVE the audit trail", () => {
    const t = allText(buildD(withImages(2)).blocks);
    expect(t.indexOf("5️⃣ TAG CHECK")).toBeLessThan(t.indexOf("*STORIES*"));
  });

  it("gives caption, first comment and pinned comment their OWN fences", () => {
    const fenced = (buildD(withImages(1)).blocks as Block[])
      .filter((b) => (b.text?.text ?? "").includes("```"));
    expect(fenced.length).toBeGreaterThanOrEqual(3);
    for (const f of fenced) expect((f.text!.text.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("preserves the audit content below the checklist", () => {
    const t = allText(buildD(withImages(1)).blocks);
    expect(t).toContain("*STORIES*");
    expect(t).toContain("thresholds: BIG≥");
    expect(t).toContain("86 gathered");
  });
});

describe("capBlocks — Slack's 50-block ceiling", () => {
  it("passes a normal message through untouched", () => {
    const b = Array.from({ length: 20 }, () => ({ type: "divider" }));
    expect(capBlocks(b)).toHaveLength(20);
  });

  it("trims from the END so the checklist survives, not the audit", () => {
    const b = Array.from({ length: 80 }, (_, i) => ({ type: "divider", n: i }));
    const out = capBlocks(b) as { n?: number }[];
    expect(out).toHaveLength(SLACK_BLOCK_CEILING);
    expect(out[0]!.n).toBe(0);                       // head kept
    expect(out.at(-1)).toHaveProperty("type", "context"); // truncation notice
  });

  it("says how much it dropped", () => {
    const out = capBlocks(Array.from({ length: 60 }, () => ({ type: "divider" })));
    expect(JSON.stringify(out.at(-1))).toContain("truncated");
  });

  it("a real package stays under the ceiling", () => {
    expect(buildD(withImages(5)).blocks.length).toBeLessThanOrEqual(SLACK_BLOCK_CEILING);
  });
});
