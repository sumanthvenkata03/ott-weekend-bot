// NEWS DESK · D — the receipt rule (N1) in code. No API is called by this suite:
// it drives the pure guard that overrides model optimism.
import { describe, it, expect } from "vitest";
import { applyReceiptRule, isReceipt } from "../news-verify.js";

describe("isReceipt", () => {
  it("accepts a real outlet page", () => {
    expect(isReceipt("https://www.thehindu.com/entertainment/movies/article12345.ece")).toBe(true);
    expect(isReceipt("http://cinemaexpress.com/tamil/2026/jul/18/raayan")).toBe(true);
  });

  it("REJECTS the aggregator we gathered from — a redirect is not a receipt", () => {
    expect(isReceipt("https://news.google.com/rss/articles/CBMiABC")).toBe(false);
    expect(isReceipt("https://www.google.com/search?q=raayan+national+award")).toBe(false);
  });

  it("rejects a non-url, an empty string, and a non-http scheme", () => {
    expect(isReceipt("")).toBe(false);
    expect(isReceipt("thehindu.com/article")).toBe(false);
    expect(isReceipt("ftp://thehindu.com/x")).toBe(false);
  });
});

describe("applyReceiptRule — code overrides model optimism", () => {
  it("passes a confirmed verdict that carries a real outlet URL", () => {
    const out = applyReceiptRule({
      confirmed: true,
      sourceUrl: "https://www.thehindu.com/entertainment/article1.ece",
      basis: "The Hindu reports Raayan won Best Tamil Film",
    });
    expect(out.confirmed).toBe(true);
    expect(out.sourceUrl).toBe("https://www.thehindu.com/entertainment/article1.ece");
  });

  it("DEMOTES confirmed-with-no-url to held", () => {
    const out = applyReceiptRule({ confirmed: true, sourceUrl: "", basis: "I know this is true" });
    expect(out.confirmed).toBe(false);
    expect(out.sourceUrl).toBe("");
    expect(out.basis).toContain("held by receipt rule");
  });

  it("DEMOTES confirmed-citing-the-aggregator to held", () => {
    const out = applyReceiptRule({
      confirmed: true,
      sourceUrl: "https://news.google.com/rss/articles/CBMiABC",
      basis: "found on Google News",
    });
    expect(out.confirmed).toBe(false);
    expect(out.basis).toContain("held by receipt rule");
  });

  it("keeps an unconfirmed verdict unconfirmed and strips any URL it carried", () => {
    const out = applyReceiptRule({
      confirmed: false,
      sourceUrl: "https://www.thehindu.com/x.ece",
      basis: "only aggregator copies found",
    });
    expect(out.confirmed).toBe(false);
    expect(out.sourceUrl).toBe("");
    expect(out.basis).toBe("only aggregator copies found");
  });

  it("never leaves an unconfirmed story without a stated reason (N1)", () => {
    const out = applyReceiptRule({ confirmed: false, sourceUrl: "", basis: "" });
    expect(out.basis).not.toBe("");
  });
});
