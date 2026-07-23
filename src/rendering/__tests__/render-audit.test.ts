// CHECKPOINT 3 — the post-render audit.
// Asserts over pre-raster HTML + dimensions. No Puppeteer, no network, no OCR.
import { describe, it, expect } from "vitest";
import {
  auditBlockers,
  auditRender,
  auditSubject,
  WED_CARD_PX,
  WED_COVER_PX,
  type AuditSubject,
} from "../render-audit.js";

/** Markup shaped like wed-drop-card.html's real output. */
function cardHtml(opts: { title?: string; released?: boolean; availableIn?: boolean; poster?: boolean; why?: boolean } = {}) {
  const { title = "Complete Film", released = true, availableIn = true, poster = true, why = true } = opts;
  return [
    '<div class="canvas">',
    '<div class="masthead"><span class="label">★ WED DROP · IN THEATERS</span></div>',
    poster ? '<img class="poster-img" src="x.jpg" />' : '<div class="poster-fallback">fallback</div>',
    `<div class="film-title">${title}</div>`,
    released ? '<div class="released-section"><div class="section-label">★ RELEASED</div></div>' : "",
    availableIn ? '<div class="languages-section"><div class="section-label">★ AVAILABLE IN</div></div>' : "",
    why ? '<div class="why-block"><div class="why-label">★ WHY THIS WEEKEND</div></div>' : "",
    "</div>",
  ].join("\n");
}

const card = (label: string, html: string, p: Partial<AuditSubject> = {}): AuditSubject => ({
  label, kind: "wed-card", html,
  pngWidth: WED_CARD_PX.width, pngHeight: WED_CARD_PX.height, ...p,
});
const cover = (p: Partial<AuditSubject> = {}): AuditSubject => ({
  label: "cover", kind: "wed-cover",
  html: '<div class="meta">5 FILMS · JUN 17 — JUN 21 · 2026</div>',
  pngWidth: WED_COVER_PX.width, pngHeight: WED_COVER_PX.height, ...p,
});

describe("audit — a complete card set PASSES", () => {
  it("cover + 2 complete cards, correct dims ⇒ ok", () => {
    const r = auditRender({
      cover: cover(), cards: [card("card-01", cardHtml()), card("card-02", cardHtml())], coverFilmCount: 2,
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(3);
  });

  it("a poster-less card still passes on the typographic fallback (R5)", () => {
    const r = auditRender({ cards: [card("card-01", cardHtml({ poster: false }))] });
    expect(r.ok).toBe(true);
  });
});

describe("FOUNDING FIXTURE — Chennai Love Story's render FAILS the audit", () => {
  // Card 11 of Issue 026 rendered with no ★ RELEASED band and shipped anyway.
  const chennai = card("card-11", cardHtml({ title: "Chennai Love Story", released: false }), {
    expectTitle: "Chennai Love Story",
  });

  it("names audit:band-released", () => {
    const r = auditRender({ cards: [chennai] });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.check)).toContain("audit:band-released");
  });

  it("the finding is attributed to the card, with a readable detail", () => {
    const f = auditRender({ cards: [chennai] }).findings.find((x) => x.check === "audit:band-released")!;
    expect(f.subject).toBe("card-11");
    expect(f.detail).toContain("★ RELEASED");
  });
});

describe("FOUNDING FIXTURE — Ottam Thullal's render FAILS the audit", () => {
  // Card 12: ★ RELEASED present, ★ AVAILABLE IN structurally impossible.
  const ottam = card("card-12", cardHtml({ title: "Ottam Thullal", availableIn: false }), {
    expectTitle: "Ottam Thullal",
  });

  it("names audit:band-available-in", () => {
    const r = auditRender({ cards: [ottam] });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.check)).toContain("audit:band-available-in");
  });

  it("does NOT report the band it actually had", () => {
    const checks = auditRender({ cards: [ottam] }).findings.map((f) => f.check);
    expect(checks).not.toContain("audit:band-released");
  });
});

describe("audit — the Issue 026 deck as a whole", () => {
  it("both bad cards are caught in one pass, alongside the good ones", () => {
    const r = auditRender({
      cover: cover(),
      cards: [
        card("card-10", cardHtml()),
        card("card-11", cardHtml({ title: "Chennai Love Story", released: false })),
        card("card-12", cardHtml({ title: "Ottam Thullal", availableIn: false })),
      ],
      coverFilmCount: 3,
    });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(2);
    expect(r.findings.map((f) => f.subject).sort()).toEqual(["card-11", "card-12"]);
  });
});

describe("audit — per-card slot presence", () => {
  it("a missing title is caught", () => {
    const r = auditRender({ cards: [card("card-01", cardHtml({ title: "Something Else" }), { expectTitle: "Expected Title" })] });
    expect(r.findings.map((f) => f.check)).toContain("audit:title");
  });

  it("a missing why-block is caught — the card would carry no copy", () => {
    const r = auditRender({ cards: [card("card-01", cardHtml({ why: false }))] });
    expect(r.findings.map((f) => f.check)).toContain("audit:why-block");
  });

  it("neither poster art NOR fallback ⇒ a hole in the card", () => {
    const bare = '<div class="canvas"><div class="film-title">T</div>' +
      '<div class="section-label">★ RELEASED</div><div class="section-label">★ AVAILABLE IN</div>' +
      '<div class="why-label">★ WHY THIS WEEKEND</div></div>';
    expect(auditRender({ cards: [card("card-01", bare)] }).findings.map((f) => f.check))
      .toContain("audit:poster-slot");
  });

  it("titles survive entity encoding", () => {
    const html = cardHtml({ title: "Tom &amp; Jerry" });
    const r = auditRender({ cards: [card("card-01", html, { expectTitle: "Tom & Jerry" })] });
    expect(r.ok).toBe(true);
  });
});

describe("audit — exact dimensions", () => {
  it("a card must be exactly 2160×2160", () => {
    const r = auditRender({ cards: [card("card-01", cardHtml(), { pngWidth: 2160, pngHeight: 2159 })] });
    const f = r.findings.find((x) => x.check === "audit:dimensions")!;
    expect(f.detail).toContain("2160×2159");
    expect(f.detail).toContain("2160×2160");
  });

  it("a cover must be exactly 2160×2700", () => {
    const r = auditRender({ cover: cover({ pngWidth: 1080, pngHeight: 1350 }), cards: [] });
    expect(r.findings.map((f) => f.check)).toContain("audit:dimensions");
  });

  it("unmeasurable dimensions are a finding, never a silent pass", () => {
    // A subject with NO measured dimensions — the fields are absent, not
    // undefined (exactOptionalPropertyTypes distinguishes them).
    const unmeasured: AuditSubject = { label: "card-01", kind: "wed-card", html: cardHtml() };
    const r = auditRender({ cards: [unmeasured] });
    const f = r.findings.find((x) => x.check === "audit:dimensions")!;
    expect(f.detail).toContain("unavailable");
  });
});

describe("audit — count-vs-cover agreement", () => {
  it("a cover claiming more films than cards rendered is caught", () => {
    const r = auditRender({ cover: cover(), cards: [card("card-01", cardHtml())], coverFilmCount: 5 });
    const f = r.findings.find((x) => x.check === "audit:count-vs-cover")!;
    expect(f.detail).toContain("claims 5");
    expect(f.detail).toContain("1 card");
  });

  it("agreement passes", () => {
    expect(auditRender({ cover: cover(), cards: [card("c1", cardHtml()), card("c2", cardHtml())], coverFilmCount: 2 }).ok).toBe(true);
  });

  it("no claimed count ⇒ the check is skipped, not failed", () => {
    expect(auditRender({ cover: cover(), cards: [card("c1", cardHtml())] }).ok).toBe(true);
  });
});

describe("audit — covers are not card-audited", () => {
  it("a cover is not required to carry card bands", () => {
    expect(auditSubject(cover())).toEqual([]);
  });
});

describe("auditBlockers — feeds the red ping", () => {
  it("maps findings to blockers on the audit layer", () => {
    const r = auditRender({ cards: [card("card-11", cardHtml({ released: false }))] });
    const b = auditBlockers(r);
    expect(b[0]!.layer).toBe("audit");
    expect(b[0]!.title).toBe("card-11");
    expect(b[0]!.check).toContain("audit:band-released");
  });

  it("a render fault is never advertised as self-clearing", () => {
    // Same inputs reproduce it: re-running is not a fix, so the ping must not
    // imply waiting will help.
    const r = auditRender({ cards: [card("card-11", cardHtml({ released: false }))] });
    expect(auditBlockers(r).every((x) => x.recoverable === false)).toBe(true);
  });

  it("a clean audit yields no blockers", () => {
    expect(auditBlockers(auditRender({ cards: [card("c1", cardHtml())] }))).toEqual([]);
  });
});
