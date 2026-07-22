// NEWS DESK · A — feed parsing, the 26h window, and the outlet-suffix strip.
// Pure only: no network is touched by this suite.
import { describe, it, expect } from "vitest";
import {
  NEWS_QUERIES,
  WINDOW_HOURS,
  feedUrl,
  parseNewsFeed,
  stripOutletSuffix,
  withinWindow,
} from "../news-gather.js";

const NOW = Date.parse("2026-07-18T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toUTCString();

const feed = (items: string) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const rssItem = (title: string, source: string, pubDate: string, link = "https://news.google.com/rss/articles/A") =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate><source url="x">${source}</source></item>`;

describe("NEWS_QUERIES", () => {
  it("covers exactly the seven editorial languages", () => {
    expect(NEWS_QUERIES).toHaveLength(7);
    expect(NEWS_QUERIES.map((q) => q.language)).toEqual([
      "Hindi", "Telugu", "Tamil", "Malayalam", "Kannada", "Marathi", "Punjabi",
    ]);
  });

  it("REGRESSION — the news desk no longer queries Bengali and no longer skips Punjabi", () => {
    // The desk used to query bn and never query pa: the discovery split-brain,
    // reproduced in a second pipeline. The Bengali query in particular
    // ("Bengali cinema Bangla …") is what surfaced Mastul, a Bangladeshi film.
    const langs = NEWS_QUERIES.map((q) => q.language);
    expect(langs).not.toContain("Bengali");
    expect(langs).toContain("Punjabi");
    // And no query TEXT may reach for Bengali/Bangla either — the language set
    // and the query strings must not disagree.
    const allQueryText = NEWS_QUERIES.map((q) => q.query).join(" ").toLowerCase();
    expect(allQueryText).not.toContain("bengali");
    expect(allQueryText).not.toContain("bangla");
  });
});

describe("feedUrl", () => {
  it("narrows at the source with when:2d and pins the India/English edition", () => {
    const u = feedUrl("Tamil cinema news");
    expect(u).toContain("when%3A2d");
    expect(u).toContain("hl=en-IN&gl=IN&ceid=IN:en");
  });
});

describe("stripOutletSuffix", () => {
  it("removes the ' - Outlet' Google appends", () => {
    expect(stripOutletSuffix("Raayan wins best Tamil film - Cinema Express", "Cinema Express"))
      .toBe("Raayan wins best Tamil film");
  });

  it("leaves a dash that is part of the headline alone", () => {
    expect(stripOutletSuffix("Balan - The Boy gets a date", "Pinkvilla")).toBe("Balan - The Boy gets a date");
  });

  it("is a no-op with no source", () => {
    expect(stripOutletSuffix("A headline - Somewhere", "")).toBe("A headline - Somewhere");
  });
});

describe("withinWindow", () => {
  it("accepts items inside the 26h window and rejects older ones", () => {
    expect(withinWindow(new Date(NOW - 1 * 3600_000).toISOString(), NOW)).toBe(true);
    expect(withinWindow(new Date(NOW - 25 * 3600_000).toISOString(), NOW)).toBe(true);
    expect(withinWindow(new Date(NOW - 27 * 3600_000).toISOString(), NOW)).toBe(false);
  });

  it("is overlap-safe: 24h+ still qualifies, so a late run loses nothing", () => {
    expect(WINDOW_HOURS).toBe(26);
    expect(withinWindow(new Date(NOW - 24.5 * 3600_000).toISOString(), NOW)).toBe(true);
  });

  it("rejects an unparseable date rather than guessing", () => {
    expect(withinWindow("not a date", NOW)).toBe(false);
  });

  it("rejects a far-future date as bad data", () => {
    expect(withinWindow(new Date(NOW + 5 * 3600_000).toISOString(), NOW)).toBe(false);
  });
});

describe("parseNewsFeed", () => {
  it("maps title, url, outlet, and date, stripping the outlet suffix", () => {
    const xml = feed(rssItem("Raayan wins best Tamil film - Cinema Express", "Cinema Express", hoursAgo(2)));
    const [item] = parseNewsFeed(xml, "Tamil");
    expect(item).toMatchObject({
      title: "Raayan wins best Tamil film",
      source: "Cinema Express",
      language: "Tamil",
    });
    expect(item!.url).toContain("news.google.com");
  });

  it("handles a single-item channel (fast-xml-parser returns an object, not an array)", () => {
    const xml = feed(rssItem("Lone story", "The Hindu", hoursAgo(1)));
    expect(parseNewsFeed(xml, "Tamil")).toHaveLength(1);
  });

  it("returns [] for an empty channel", () => {
    expect(parseNewsFeed(feed(""), "Tamil")).toEqual([]);
  });

  it("DROPS an item with an unparseable date rather than defaulting it", () => {
    const xml = feed(
      rssItem("Good item", "The Hindu", hoursAgo(1)) + rssItem("Bad date", "The Hindu", "sometime last week")
    );
    const out = parseNewsFeed(xml, "Tamil");
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Good item");
  });

  it("keeps every leaf a string — a numeric-looking title is not coerced", () => {
    const xml = feed(rssItem("2026", "The Hindu", hoursAgo(1)));
    expect(parseNewsFeed(xml, "Tamil")[0]!.title).toBe("2026");
  });
});
