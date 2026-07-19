// NEWS DESK — pinned-comment source attribution. Pure; no API is called.
//
// Regression for a real shipped bug: the pinned comment paired the CLUSTER's
// first outlet with the VERIFICATION's sourceUrl, printing "Business Standard —
// https://outlookindia.com/…" and printing it twice.
import { describe, it, expect } from "vitest";
import { DOMAIN_OUTLET, buildSourceLines, clampWords, outletForUrl, stripHeadlineTail } from "../news-caption.js";
import { fallbackCardLine } from "../../../rendering/render-news.js";

describe("outletForUrl", () => {
  it("names a Tier-A registry domain", () => {
    expect(outletForUrl("https://www.thehindu.com/entertainment/article1.ece")).toBe("The Hindu");
    expect(outletForUrl("https://cinemaexpress.com/tamil/2026/jul/18/raayan")).toBe("Cinema Express");
    expect(outletForUrl("https://123telugu.com/mnews/x.html")).toBe("123telugu");
  });

  it("names an outlet verification actually cited in live runs", () => {
    expect(outletForUrl("https://www.outlookindia.com/art-entertainment/x")).toBe("Outlook India");
    expect(outletForUrl("https://www.republicworld.com/entertainment/ott/x")).toBe("Republic World");
    expect(outletForUrl("https://www.dtnext.in/entertainment/cinema/x")).toBe("DT Next");
  });

  it("credits the parent masthead through a subdomain", () => {
    expect(outletForUrl("https://tamil.thehindu.com/cinema/x")).toBe("The Hindu");
  });

  it("prints the BARE DOMAIN for an unknown outlet rather than guessing", () => {
    expect(outletForUrl("https://someneweoutlet.co.in/story/1")).toBe("someneweoutlet.co.in");
    expect(outletForUrl("https://www.tupaki.com/x")).toBe("tupaki.com");
  });

  it("returns empty for an unusable URL", () => {
    expect(outletForUrl("")).toBe("");
    expect(outletForUrl("not a url")).toBe("");
  });

  it("every mapped display name is non-empty", () => {
    for (const [d, n] of Object.entries(DOMAIN_OUTLET)) {
      expect(n.length, `empty name for ${d}`).toBeGreaterThan(0);
    }
  });
});

describe("buildSourceLines — the attribution bug", () => {
  const OUTLOOK = "https://www.outlookindia.com/art-entertainment/diljit-satluj-annu-kapoor";

  it("REGRESSION — credits the URL's own domain, not the cluster's outlet", () => {
    // Yesterday's exact shape: the cluster ran under Business Standard, but the
    // page verification actually retrieved was Outlook India — and it appeared
    // twice. One line, correctly credited.
    const lines = buildSourceLines([{ sourceUrl: OUTLOOK }, { sourceUrl: OUTLOOK }]);
    expect(lines).toEqual([`Outlook India — ${OUTLOOK}`]);
    expect(lines.join(" ")).not.toContain("Business Standard");
  });

  it("keeps one line per DISTINCT cited page", () => {
    const lines = buildSourceLines([
      { sourceUrl: OUTLOOK },
      { sourceUrl: "https://www.thehindu.com/entertainment/x.ece" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Outlook India");
    expect(lines[1]).toContain("The Hindu");
  });

  it("dedupes case-insensitively", () => {
    const lines = buildSourceLines([
      { sourceUrl: "https://www.dtnext.in/A" },
      { sourceUrl: "https://www.dtnext.in/A" },
    ]);
    expect(lines).toHaveLength(1);
  });

  it("skips stories with no cited page — a held story credits nobody", () => {
    expect(buildSourceLines([{ sourceUrl: "" }, { sourceUrl: OUTLOOK }])).toHaveLength(1);
  });

  it("returns nothing for no stories", () => {
    expect(buildSourceLines([])).toEqual([]);
  });
});

// ── EDITORIAL CARD COPY (micro 2+ item 1) ──────────────────────────────────

describe("stripHeadlineTail — SEO tails never reach a card", () => {
  it("strips an outlet tail", () => {
    expect(stripHeadlineTail("Chandu Champion Wins Big | Etimes")).toBe("Chandu Champion Wins Big");
    expect(stripHeadlineTail("Balan The Boy locks a date - Times of India")).toBe("Balan The Boy locks a date");
  });

  it("strips STACKED tails", () => {
    expect(stripHeadlineTail("Raayan takes Best Tamil Film | Etimes | Times of India"))
      .toBe("Raayan takes Best Tamil Film");
  });

  it("strips SEO cue fragments", () => {
    expect(stripHeadlineTail("Where to stream the thriller — watch video")).toBe("Where to stream the thriller");
    expect(stripHeadlineTail("The complete winners list | full list")).toBe("The complete winners list");
  });

  it("leaves a legitimate dash inside a title alone", () => {
    expect(stripHeadlineTail("35 – Chinna Katha Kaadu wins big")).toBe("35 – Chinna Katha Kaadu wins big");
  });
});

describe("clampWords — the word-boundary ellipsis law", () => {
  it("leaves a short line untouched", () => {
    expect(clampWords("Balan The Boy Locks Its Date", 90)).toBe("Balan The Boy Locks Its Date");
  });

  it("REGRESSION — never clips mid-word ('Chandu C')", () => {
    const out = clampWords("Kartik Aaryan Shares Best Actor For Chandu Champion At The National Awards", 40);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\bC…$/);          // the exact shape of the live bug
    // Every word before the ellipsis is whole.
    for (const w of out.replace(/…$/, "").trim().split(" ")) expect(w.length).toBeGreaterThan(0);
    expect("Kartik Aaryan Shares Best Actor For Chandu Champion At The National Awards")
      .toContain(out.replace(/…$/, "").trim());
  });

  it("respects the cap", () => {
    expect(clampWords("a".repeat(10) + " " + "b".repeat(10) + " " + "c".repeat(10), 25).length)
      .toBeLessThanOrEqual(25);
  });

  it("hard-cuts a single word longer than the budget, still marked", () => {
    const out = clampWords("Supercalifragilisticexpialidocious", 12);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it("never leaves dangling punctuation before the ellipsis", () => {
    expect(clampWords("Raayan wins Best Tamil Film, and more news follows", 26)).not.toMatch(/[,;:]…$/);
  });
});

describe("fallbackCardLine — a failed caption still yields a readable card", () => {
  it("strips the tail and clamps, so a blank card is impossible", () => {
    const out = fallbackCardLine("Kartik Aaryan Shares Best Actor For Chandu Champion At The 72nd National Film Awards | Etimes");
    expect(out).not.toContain("Etimes");
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out).not.toMatch(/\bC…$/);
  });

  it("passes a short clean headline through untouched", () => {
    expect(fallbackCardLine("Raayan takes Best Tamil Film")).toBe("Raayan takes Best Tamil Film");
  });
});
