// WD-042 Part 5a — a missing platform logo degrades to text, loudly.
//
// Issue 042 shipped Aakhri Sawal with "★ NOW ON LIONSGATE PLAY" followed by an
// empty white box: platformLogoSvg returns "" for a missing asset, but the
// template emitted <span class="logo-stamp"></span> regardless, and nothing in
// the manifest said the mark was missing. Now: no asset → no chip container at
// all, plus a manifest warn naming the stem.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { platformLogoStem, platformLogoExists, missingPlatformLogos } from "../platform-logo.js";
import { buildManifest, assertRenderable, type FilmInBucket } from "../post-validator.js";
import type { Release } from "../types.js";

const code = (src: string) => src.replace(/\{#[\s\S]*?#\}/g, " ");

describe("platformLogoStem — byte-identical to the transform already in use", () => {
  it.each([
    ["Netflix", "netflix"],
    ["Prime Video", "prime-video"],
    ["Apple TV+", "apple-tv-plus"],
    ["Sun NXT", "sun-nxt"],
    ["JioHotstar", "jiohotstar"],
    ["Jio Hotstar", "jiohotstar"],
    ["ManoramaMAX", "manoramamax"],
    ["Lionsgate Play", "lionsgate-play"],
    ["SonyLIV", "sonyliv"],
    ["ZEE5", "zee5"],
  ])("%s → %s", (platform, stem) => {
    expect(platformLogoStem(platform)).toBe(stem);
  });
});

describe("platformLogoExists — the real asset directory", () => {
  it("resolves the marks we actually ship", () => {
    for (const stem of ["netflix", "prime-video", "zee5", "sun-nxt", "manoramamax"]) {
      expect(platformLogoExists(stem), stem).toBe(true);
    }
  });

  it("reports the ones we do not", () => {
    expect(platformLogoExists("lionsgate-play")).toBe(false);
    expect(platformLogoExists("totally-fake-platform")).toBe(false);
  });

  it("an empty or whitespace stem is false, never a directory read", () => {
    expect(platformLogoExists("")).toBe(false);
    expect(platformLogoExists("   ")).toBe(false);
  });

  it("missingPlatformLogos reports only the absent ones, in card order", () => {
    expect(missingPlatformLogos(["Netflix", "Lionsgate Play", "ZEE5"])).toEqual(["lionsgate-play"]);
    expect(missingPlatformLogos(["Netflix", "ZEE5"])).toEqual([]);
    expect(missingPlatformLogos([])).toEqual([]);
  });
});

describe("the manifest warns, and the warn does not block", () => {
  const mk = (platform: string[]): Release => ({
    id: "tmdb-x", title: "Test Film", language: "Hindi", isSeries: false,
    platform: platform as Release["platform"], releaseDate: "2026-08-14",
    releaseDates: { theatrical: "2026-06-01", ott: "2026-08-14" },
    genre: ["Drama"], cast: ["A Actor"], leadCast: ["A Actor"],
    synopsis: "x".repeat(120), subtitleLanguages: [], sources: ["tmdb"],
    posterUrl: "https://image.tmdb.org/t/p/w500/x.jpg",
    audioLanguages: { original: "Hindi" },
    fetchedAt: "2026-08-13T00:00:00.000Z",
  } as Release);

  const manifest = (film: Release) =>
    buildManifest("Wed Drop · Now Streaming", "042",
      [{ film, bucket: "ott", whyLine: "A grounded reason to watch, at length." } as FilmInBucket],
      { ott: { start: "2026-08-10", end: "2026-08-16", dateField: "ott", label: "Now Streaming" } },
      {}, { cardType: "wed-drop", editionDate: "2026-08-13" });

  it("A FAKE STEM produces the named warn", () => {
    const m = manifest(mk(["Lionsgate Play"]));
    expect(m.rows[0]!.status).toBe("warn");
    expect(m.rows[0]!.reason).toContain("platform-logo-missing: lionsgate-play");
    expect(m.rows[0]!.reason).toContain("text-only platform line");
  });

  it("the warn is NON-BLOCKING — the edition still renders", () => {
    const m = manifest(mk(["Lionsgate Play"]));
    expect(m.ok).toBe(true);
    expect(() => assertRenderable(m)).not.toThrow();
  });

  it("a platform WITH a mark produces no warn", () => {
    const m = manifest(mk(["Netflix"]));
    expect(m.rows[0]!.status).toBe("pass");
    expect(m.rows[0]!.reason).not.toContain("platform-logo-missing");
  });

  it("ManoramaMAX no longer warns — WD-041 installed that mark", () => {
    const m = manifest(mk(["ManoramaMAX"]));
    expect(m.rows[0]!.reason).not.toContain("platform-logo-missing");
  });
});

describe("the template draws NO chip container when the asset is missing", () => {
  const tpl = code(readFileSync(join(process.cwd(), "src/rendering/templates/wed-drop-card.html"), "utf8"));

  it("guards on the RESOLVED svg, not merely on the stem", () => {
    // The old shape `{% if stem %}<span class="logo-stamp">…` is exactly the bug:
    // a stem always exists for a named platform, so the box always rendered.
    expect(tpl).toContain("set logoSvg = stem | platformLogoSvg");
    expect(tpl).toContain("{% if logoSvg %}");
    expect(tpl).not.toMatch(/\{%\s*if stem\s*%\}\s*<span class="logo-stamp">/);
  });

  it("the logo-stamp span exists ONLY inside that guard", () => {
    const occurrences = tpl.split('class="logo-stamp"').length - 1;
    expect(occurrences).toBe(1);
    const guardAt = tpl.indexOf("{% if logoSvg %}");
    const spanAt = tpl.indexOf('class="logo-stamp"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(spanAt);
  });

  it("the platform NAME still renders regardless — the line never goes blank", () => {
    expect(tpl).toContain("NOW ON");
    expect(tpl).toContain("release.platform[0] | upper");
    // …and the name is emitted OUTSIDE the logo guard.
    expect(tpl.indexOf("release.platform[0] | upper")).toBeLessThan(tpl.indexOf("{% if logoSvg %}"));
  });
});
