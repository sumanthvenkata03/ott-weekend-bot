// src/rendering/render-audit.ts
// CHECKPOINT 3 of 3 — the post-render audit (ruling R9).
//
// The contract (checkpoint 2) proves the DATA was complete. This proves the
// PIXELS came out. They are different failures: a field can be present and the
// template still drop it, and a template can be right while the data is thin.
// Issue 026 shipped two cards with missing bands; nothing between "we have the
// data" and "it's on R2" ever looked at the output.
//
// WHAT IT ASSERTS AGAINST — three cheap, reliable surfaces, no OCR:
//   1. the PRE-RASTER HTML (renderer.ts now returns it instead of discarding it)
//   2. the render context we passed in
//   3. the PNG's real dimensions (sharp)
//
// Pixel inspection is deliberately out of scope: it is slow, flaky, and the
// HTML is a strictly better oracle for "did this element render" — if the band
// markup is absent from the HTML it cannot be in the PNG, and if it is present
// the template's own CSS put it on screen.
//
// PURE. The caller does the sharp read and hands the numbers in.

/** The canvas contract, in DEVICE pixels (CSS px × deviceScaleFactor 2). */
export const WED_COVER_PX = { width: 2160, height: 2700 } as const;
export const WED_CARD_PX = { width: 2160, height: 2160 } as const;

export type AuditedKind = "wed-cover" | "wed-card";

export interface AuditSubject {
  /** Card 03, cover, … — used to name the finding. */
  label: string;
  kind: AuditedKind;
  /** Pre-raster HTML from RenderArtifact. */
  html: string;
  /** Real PNG dimensions. Omit when unavailable; the dim check then reports it. */
  pngWidth?: number;
  pngHeight?: number;
  /** Title the card must display. */
  expectTitle?: string;
}

export interface AuditFinding {
  subject: string;
  check: string;
  detail: string;
}

export interface AuditResult {
  ok: boolean;
  findings: AuditFinding[];
  checked: number;
}

/** Markup markers. These are the template's own strings — see wed-drop-card.html. */
const BAND_RELEASED = "★ RELEASED";
const BAND_AVAILABLE_IN = "★ AVAILABLE IN";
const WHY_LABEL = "★ WHY THIS WEEKEND";
const POSTER_IMG = 'class="poster-img"';
const POSTER_FALLBACK = 'class="poster-fallback';

/** Collapse entities/whitespace so a title comparison is not defeated by markup. */
function normalize(html: string): string {
  return html.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/\s+/g, " ");
}

function expectedPx(kind: AuditedKind): { width: number; height: number } {
  return kind === "wed-cover" ? WED_COVER_PX : WED_CARD_PX;
}

/**
 * Audit ONE rendered surface.
 *
 * Card checks: title present · poster (real art OR the typographic fallback —
 * R5 makes a missing poster a warn, never a render failure) · why-block ·
 * BOTH bands · exact dimensions.
 */
export function auditSubject(s: AuditSubject): AuditFinding[] {
  const out: AuditFinding[] = [];
  const html = normalize(s.html);
  const add = (check: string, detail: string) => out.push({ subject: s.label, check, detail });

  if (s.expectTitle && !html.includes(normalize(s.expectTitle))) {
    add("audit:title", `expected title "${s.expectTitle}" is absent from the rendered markup`);
  }

  if (s.kind === "wed-card") {
    // Poster: EITHER real art or the designed fallback. Absent both ⇒ a hole.
    if (!html.includes(POSTER_IMG) && !html.includes(POSTER_FALLBACK)) {
      add("audit:poster-slot", "neither poster art nor the typographic fallback rendered");
    }
    if (!html.includes(WHY_LABEL)) {
      add("audit:why-block", `the "${WHY_LABEL}" block did not render — the card has no editorial copy`);
    }
    // THE ISSUE-026 CHECKS. Chennai lost the first, Ottam the second.
    if (!html.includes(BAND_RELEASED)) {
      add("audit:band-released", `the "${BAND_RELEASED}" band did not render`);
    }
    if (!html.includes(BAND_AVAILABLE_IN)) {
      add("audit:band-available-in", `the "${BAND_AVAILABLE_IN}" band did not render`);
    }
  }

  const exp = expectedPx(s.kind);
  if (s.pngWidth === undefined || s.pngHeight === undefined) {
    add("audit:dimensions", "PNG dimensions unavailable — the file could not be measured");
  } else if (s.pngWidth !== exp.width || s.pngHeight !== exp.height) {
    add(
      "audit:dimensions",
      `${s.pngWidth}×${s.pngHeight} but ${s.kind} must be exactly ${exp.width}×${exp.height}`
    );
  }

  return out;
}

export interface AuditInput {
  cover?: AuditSubject;
  cards: AuditSubject[];
  /** The film count the COVER claims. Must equal the number of cards. */
  coverFilmCount?: number;
}

/**
 * Audit a whole edition. `ok:false` means the package is NOT delivered — an
 * unaudited or failing package never reaches R2 or Slack.
 */
export function auditRender(input: AuditInput): AuditResult {
  const findings: AuditFinding[] = [];
  if (input.cover) findings.push(...auditSubject(input.cover));
  for (const c of input.cards) findings.push(...auditSubject(c));

  // COUNT-VS-COVER. The cover promises "N FILMS" and a swipe for N; a mismatch
  // is a visible lie on slide one and was never checked.
  if (input.coverFilmCount !== undefined && input.coverFilmCount !== input.cards.length) {
    findings.push({
      subject: "cover",
      check: "audit:count-vs-cover",
      detail: `cover claims ${input.coverFilmCount} film(s) but ${input.cards.length} card(s) rendered`,
    });
  }

  return {
    ok: findings.length === 0,
    findings,
    checked: (input.cover ? 1 : 0) + input.cards.length,
  };
}

/** Audit findings → the blocker shape the red ping consumes. */
export function auditBlockers(
  result: AuditResult
): { title: string; layer: "audit"; check: string; recoverable: boolean }[] {
  return result.findings.map((f) => ({
    title: f.subject,
    layer: "audit" as const,
    check: `${f.check} — ${f.detail}`,
    // A render fault is a code/data fault, not weather: re-running the same
    // inputs reproduces it. Never advertised as self-clearing.
    recoverable: false,
  }));
}
