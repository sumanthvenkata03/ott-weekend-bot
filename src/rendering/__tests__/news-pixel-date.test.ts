// CLEAN PIXELS — the news desk's pixel-bound slots.
//
// The news lane was the worst offender: it printed `istDate`, the raw machine
// stamp "2026-07-22", straight into the card footer and the register eyebrow —
// the same string used for the R2 path and the zip name.
//
// This asserts the SLOTS AS ACTUALLY WIRED, not a re-implementation: renderToPNG
// is mocked and the `data` payload each call receives is captured. Zero network,
// zero Puppeteer, zero files written.
import { describe, it, expect, vi, beforeEach } from "vitest";

const renderCalls: { templateName: string; data: Record<string, unknown> }[] = [];
vi.mock("../renderer.js", () => ({
  renderToPNG: vi.fn(async (opts: { templateName: string; data: Record<string, unknown> }) => {
    renderCalls.push({ templateName: opts.templateName, data: opts.data });
  }),
}));
vi.mock("../poster-crop.js", () => ({ computeCropPosition: vi.fn(async () => "center 30%") }));
vi.mock("node:fs", () => ({ promises: { mkdir: vi.fn(async () => undefined), readFile: vi.fn(async () => { throw new Error("no pill"); }) } }));

const { renderNews } = await import("../render-news.js");
import type { ComposedEdition, SelectedStory } from "../../content/news/news-compose.js";

const IST_DATE = "2026-07-22";
const EXPECTED_HUMAN = "JUL 22 · 2026";

const story = (headline: string, withPoster: boolean): SelectedStory => ({
  segment: { key: "RADAR", badge: "TBSI RADAR", signoff: "" },
  segmentReason: "test",
  resolved: {
    story: {
      cluster: {
        id: `c-${headline.length}`,
        headline,
        language: "Telugu",
        storyClass: "ott-date",
        outlets: ["Cinema Express", "123telugu"],
        score: 9,
      },
      confirmed: true,
      sourceUrl: "https://cinemaexpress.com/x",
      basis: "page names the film",
      films: [],
    },
    film: withPoster
      ? { title: "Varavu", confidence: "quoted", tmdbId: 1542187, posterUrl: "https://image.tmdb.org/t/p/w500/v.jpg" }
      : null,
    films: [],
    reason: "",
  },
} as unknown as SelectedStory);

const edition = (format: string, cards: SelectedStory[]): ComposedEdition => ({
  format, explodeFilms: false, why: "test", cover: cards[0] ?? null, cards, dropped: [],
} as unknown as ComposedEdition);

/** Every string value handed to a template, flattened. */
function allSlotStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  renderCalls.forEach((c) => walk(c.data));
  return out;
}

beforeEach(() => { renderCalls.length = 0; });

describe("jn-skin — the footer slot", () => {
  it("carries the HUMAN date, not the machine stamp", async () => {
    await renderNews(edition("jn-skin", [story("'Varavu' locks its OTT date", true)]), IST_DATE);
    const footer = String(renderCalls[0]!.data.footer);
    expect(footer).toContain(EXPECTED_HUMAN);
    expect(footer).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("REPLACES rather than removes — the credit AND a date both survive", async () => {
    await renderNews(edition("jn-skin", [story("'Varavu' locks its OTT date", true)]), IST_DATE);
    const footer = String(renderCalls[0]!.data.footer);
    expect(footer).toContain("CINEMA EXPRESS");
    expect(footer).toBe(`CINEMA EXPRESS · 123TELUGU · ${EXPECTED_HUMAN}`);
  });
});

describe("register cover — the eyebrow slot", () => {
  it("carries badge + HUMAN date, never the machine stamp", async () => {
    await renderNews(edition("register", [
      story("A locks its date", true), story("B locks its date", true),
      story("C locks its date", true), story("D locks its date", true),
      story("E locks its date", true),
    ]), IST_DATE);
    const cover = renderCalls.find((c) => c.templateName === "news-register-cover");
    expect(cover).toBeDefined();
    const eyebrow = String(cover!.data.eyebrow);
    expect(eyebrow).toBe(`TBSI RADAR · ${EXPECTED_HUMAN}`);
    expect(eyebrow).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("NO pixel-bound slot carries a machine date or an issue token", () => {
  for (const [label, fmt, n] of [
    ["jn-skin", "jn-skin", 1],
    ["register-single", "register-single", 3],
    ["register", "register", 5],
  ] as const) {
    it(`${label}: every template value is free of /\\d{4}-\\d{2}-\\d{2}/ and of №`, async () => {
      const cards = Array.from({ length: n }, (_, i) => story(`Story ${i} locks its date`, true));
      await renderNews(edition(fmt, cards), IST_DATE);
      expect(renderCalls.length).toBeGreaterThan(0);
      for (const s of allSlotStrings()) {
        expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(s).not.toContain("№");
        expect(s).not.toMatch(/\bISSUE\b/);
        expect(s).not.toMatch(/\bVOL\./);
      }
    });
  }
});

describe("the machine stamp still drives the machine room", () => {
  it("filenames keep yyyy-MM-dd — this change is pixels-only", async () => {
    const r = await renderNews(edition("jn-skin", [story("'Varavu' locks its OTT date", true)]), IST_DATE);
    expect(r.cardPaths[0]).toContain(IST_DATE);
  });
});
