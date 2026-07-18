// NEWS DESK · B — the dedupe ledger. Proves the "reports once, ever" contract
// both purely (URL normalization) and against the real sqlite table.
import { describe, it, expect } from "vitest";
import { alreadySeen, itemKey, markAllSeen, markSeen, normalizeUrl } from "../news-seen.js";

/** Unique per test RUN so the suite is repeatable against a persistent db. */
const uniqueUrl = (tag: string) =>
  `https://news.google.com/rss/articles/${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

describe("normalizeUrl", () => {
  it("drops the volatile query string Google appends", () => {
    expect(normalizeUrl("https://news.google.com/rss/articles/CBMiABC?oc=5")).toBe(
      "news.google.com/rss/articles/CBMiABC"
    );
    expect(normalizeUrl("https://news.google.com/rss/articles/CBMiABC?oc=5&hl=en-IN")).toBe(
      normalizeUrl("https://news.google.com/rss/articles/CBMiABC")
    );
  });

  it("normalizes host case, www, and a trailing slash", () => {
    expect(normalizeUrl("https://WWW.TheHindu.com/news/")).toBe("thehindu.com/news");
  });

  it("does not throw on an unparseable url", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });
});

describe("itemKey", () => {
  it("is stable and collapses query-string variants to ONE key", () => {
    const a = itemKey("https://news.google.com/rss/articles/XYZ?oc=5");
    const b = itemKey("https://news.google.com/rss/articles/XYZ");
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("separates genuinely different articles", () => {
    expect(itemKey("https://news.google.com/rss/articles/AAA")).not.toBe(
      itemKey("https://news.google.com/rss/articles/BBB")
    );
  });
});

describe("news_seen ledger — an item reports once, ever", () => {
  it("is unseen before, seen after (the second run reports nothing)", () => {
    const url = uniqueUrl("once");
    expect(alreadySeen(url)).toBe(false);   // run 1: new
    markSeen(url);
    expect(alreadySeen(url)).toBe(true);    // run 2: already reported
  });

  it("treats a query-string variant as the SAME item on the second run", () => {
    const url = uniqueUrl("variant");
    markSeen(url);
    expect(alreadySeen(`${url}?oc=5`)).toBe(true);
  });

  it("markSeen is idempotent (INSERT OR IGNORE)", () => {
    const url = uniqueUrl("idem");
    markSeen(url);
    expect(() => markSeen(url)).not.toThrow();
    expect(alreadySeen(url)).toBe(true);
  });

  it("markAllSeen bulk-marks a whole run's items", () => {
    const urls = [uniqueUrl("bulk1"), uniqueUrl("bulk2"), uniqueUrl("bulk3")];
    expect(urls.every((u) => !alreadySeen(u))).toBe(true);
    markAllSeen(urls);
    expect(urls.every((u) => alreadySeen(u))).toBe(true);
  });

  it("SIMULATED SECOND RUN — a re-gathered identical batch yields zero new items", () => {
    const batch = [uniqueUrl("run-a"), uniqueUrl("run-b"), uniqueUrl("run-c")];
    const firstRun = batch.filter((u) => !alreadySeen(u));
    expect(firstRun).toHaveLength(3);
    markAllSeen(firstRun);

    const secondRun = batch.filter((u) => !alreadySeen(u));
    expect(secondRun).toHaveLength(0); // → quiet-day path (N4)
  });
});
