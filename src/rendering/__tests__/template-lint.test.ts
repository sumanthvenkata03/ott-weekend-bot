// TEMPLATE LINT — the permanent CLEAN-PIXELS regression net.
//
// The platform had NO test that read a template. Every meta string that reached
// a published card got there because nothing was watching. This reads the real
// template files off disk and fails if plumbing reappears in markup — so the
// clean-pixels ruling survives the next person, and the next redesign.
//
// FORBIDDEN in pixels: № · "{{ issue" · ISSUE · VOL.
// Followers see content and a date. Issue numbers, volumes, editions and
// timestamps live in the machine room: console, Slack, R2 paths, zip names,
// ledger. None of that is in scope here — this file only guards MARKUP.
//
// Reads with a glob rather than a hand-listed set, so a NEW template is covered
// the moment it is created; a list would silently miss it.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE_DIR = join(process.cwd(), "src", "rendering", "templates");

/**
 * ALLOWLIST — the single ruled exception. Archives is the only pillar whose
 * volume is a real, ledger-backed incrementing counter (archives-ledger.ts), so
 * it reads as an editorial series marker rather than plumbing. It is kept on the
 * COVER only; the Archives card footer was stripped like every other.
 * Entry shape: filename → the tokens it may carry.
 */
const ALLOWLIST: Record<string, readonly string[]> = {
  "archives-cover.html": ["VOL."],
};

const FORBIDDEN: readonly { token: string; label: string }[] = [
  { token: "№", label: "№ (numero sign)" },
  { token: "&#8470;", label: "&#8470; (numero entity)" },
  { token: "{{ issue", label: "an {{ issue* }} moustache" },
  { token: "ISSUE", label: 'the word "ISSUE"' },
  { token: "VOL.", label: '"VOL."' },
];

function templateFiles(): string[] {
  return readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".html")).sort();
}

/**
 * Markup only: strip {# nunjucks #}, <!-- html --> and /* css *​/ comments, plus
 * the whole <style> block. A comment EXPLAINING why a token was removed must not
 * trip the lint that removed it.
 */
function markupOf(src: string): string {
  return src
    .replace(/\{#[\s\S]*?#\}/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

describe("template lint — the template set is real and non-trivial", () => {
  it("finds the templates on disk", () => {
    const files = templateFiles();
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files).toContain("wed-drop-card.html");
    // jn-skin's markup — named explicitly so a rename cannot silently drop it
    // from the swept set (its {{ footer }} slot is the one the news lane fills).
    expect(files).toContain("news-radar-card.html");
    expect(files).toContain("news-register-cover.html");
    expect(files).toContain("news-register-card.html");
  });

  it("every allowlisted file still exists — a stale allowlist is a silent hole", () => {
    const files = templateFiles();
    for (const name of Object.keys(ALLOWLIST)) expect(files).toContain(name);
  });
});

describe("template lint — no plumbing in pixels", () => {
  for (const file of templateFiles()) {
    const allowed = ALLOWLIST[file] ?? [];
    for (const { token, label } of FORBIDDEN) {
      const permitted = allowed.includes(token);
      it(`${file} ${permitted ? "may carry" : "is free of"} ${label}`, () => {
        const markup = markupOf(readFileSync(join(TEMPLATE_DIR, file), "utf8"));
        if (permitted) return;             // ruled exception — asserted below
        expect(markup).not.toContain(token);
      });
    }
  }
});

describe("template lint — the ruled exception is exercised, not just tolerated", () => {
  it("archives-cover.html DOES carry VOL. (so the allowlist is load-bearing)", () => {
    // If Archives' VOL is ever ruled out too, this fails and the allowlist entry
    // must be deleted with it — the allowlist can never quietly outlive its use.
    const markup = markupOf(readFileSync(join(TEMPLATE_DIR, "archives-cover.html"), "utf8"));
    expect(markup).toContain("VOL.");
  });

  it("archives-CARD.html does NOT — the exception is cover-only", () => {
    const markup = markupOf(readFileSync(join(TEMPLATE_DIR, "archives-card.html"), "utf8"));
    expect(markup).not.toContain("VOL.");
  });
});

describe("template lint — no legacy machine date filters reach a slot", () => {
  it("no template calls the dd-mm / dd-mm-yy date filter", () => {
    // These produced "17·06" and "17·06·26". One standard pixel format now:
    // "MMM D · YYYY", supplied pre-formatted by the render scripts.
    for (const file of templateFiles()) {
      const markup = markupOf(readFileSync(join(TEMPLATE_DIR, file), "utf8"));
      expect(markup, file).not.toContain("date('dd-mm')");
      expect(markup, file).not.toContain("date('dd-mm-yy')");
      expect(markup, file).not.toContain("date('weekday-dd-mm')");
    }
  });
});
