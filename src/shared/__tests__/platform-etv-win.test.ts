// WD-ENG-08 — ETV Win in the Platform union, and mini-film eligibility pinned.
//
// ── WHAT THE DIAGNOSIS FOUND ────────────────────────────────────────────────
// Every layer BELOW the type was already built for ETV Win:
//   src/assets/platform-logos/etv-win.svg          (the orphan asset)
//   rendering/_shared.ts  "ETV Win" → var(--platform-etv-win)
//   templates/_design-tokens.html  --platform-etv-win: #E91E63
//   content/news/news-score.ts     "etv win" in its outlet vocabulary
// The Platform UNION was the only thing refusing it, so a real ETV Win release
// could never carry its own platform — it would have degraded to Streaming-TBA
// on a card whose colour and logo were sitting right there.
//
// ── MINI-FILMS ──────────────────────────────────────────────────────────────
// NO CODE excluded them. The only three runtime references in the codebase are
// SCORING bonuses (`score += 5` when runtime >= 80) in the Thu Compare and Sun
// Spotlight pickers — they rank a short lower, they never drop it, and neither
// picker is on the Wed Drop path. The single real exclusion was one line of the
// Wed Drop SELECTION PROMPT telling the model to skip "a short". That is what
// changed; the movies-only rule did not.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PLATFORMS, asExactPlatform, toPlatform } from "../platform.js";
import { platformLogoStem, platformLogoExists, missingPlatformLogos, PLATFORM_LOGO_DIR } from "../platform-logo.js";
import { PLATFORM_TAGS } from "../hashtags.js";
import type { Platform } from "../types.js";

describe("ETV Win is a first-class Platform", () => {
  it("is a member of the union at runtime", () => {
    expect(PLATFORMS).toContain("ETV Win");
  });

  it("resolves to the etv-win.svg asset that was already on disk", () => {
    expect(platformLogoStem("ETV Win")).toBe("etv-win");
    expect(platformLogoExists("etv-win")).toBe(true);
    // …and therefore a card carrying it needs NO degrade.
    expect(missingPlatformLogos(["ETV Win"])).toEqual([]);
  });

  it("passes the ENG-03 exact-spelling gate, and near-misses still do not", () => {
    expect(asExactPlatform("ETV Win")).toBe("ETV Win");
    expect(asExactPlatform("  ETV Win  ")).toBe("ETV Win");
    // Exact means exact — the seam writes straight into release.platform.
    expect(asExactPlatform("etv win")).toBeUndefined();
    expect(asExactPlatform("ETVWin")).toBeUndefined();
    expect(asExactPlatform("ETV win")).toBeUndefined();
  });

  it("press free-text normalizes onto it, so the ai-net can actually set it", () => {
    // Without this the union addition would be half a fix: the press paths read
    // the name and then fail to map it.
    expect(toPlatform("ETV Win")).toBe("ETV Win");
    expect(toPlatform("etv win")).toBe("ETV Win");
    expect(toPlatform("ETVWin")).toBe("ETV Win");
  });

  it("carries a hashtag — the exhaustive Record<Platform,…> forces one", () => {
    expect(PLATFORM_TAGS["ETV Win"]).toEqual(["#ETVWin"]);
  });

  it("the renderer already knew the name — colour token and mapping predate this", () => {
    const shared = readFileSync(join(process.cwd(), "src", "rendering", "_shared.ts"), "utf8");
    expect(shared).toContain('"ETV Win"');
    const tokens = readFileSync(join(process.cwd(), "src", "rendering", "templates", "_design-tokens.html"), "utf8");
    expect(tokens).toContain("--platform-etv-win:");
  });
});

describe("THE DRIFT GUARDS COVER THE NEW MEMBER", () => {
  it("PLATFORMS has no duplicates and every entry is exact-resolvable", () => {
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
    for (const p of PLATFORMS) expect(asExactPlatform(p), p).toBe(p);
  });

  it("the compile-time exhaustiveness guard is present and unweakened", () => {
    // Adding a union member without adding it to PLATFORMS must FAIL TO COMPILE.
    // It did exactly that during this packet — the guard earned its keep.
    const src = readFileSync(join(process.cwd(), "src", "shared", "platform.ts"), "utf8");
    expect(src).toContain("satisfies readonly Platform[]");
    expect(src).toContain("Exclude<Platform, (typeof PLATFORMS)[number]>");
  });
});

describe("UNION ↔ LOGO INVENTORY (reported, deliberately not 'fixed')", () => {
  const stems = new Set(PLATFORMS.map(platformLogoStem));
  const onDisk = readdirSync(PLATFORM_LOGO_DIR).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, ""));

  it("the six union members without a logo are UNCHANGED and degrade by design", () => {
    // Not a defect: ENG-03's manifest warn (platform-logo-missing) already makes
    // each visible, and the card ships an honest text-only platform line.
    const noLogo = PLATFORMS.filter((p) => !platformLogoExists(platformLogoStem(p)));
    expect(noLogo.sort()).toEqual(
      (["Chaupal", "Hoichoi", "Lionsgate Play", "MUBI", "Other", "Planet Marathi"] as Platform[]).sort()
    );
  });

  it("etv-win.svg is no longer an orphan; the remaining orphans are all non-Indian", () => {
    const orphans = onDisk.filter((s) => !stems.has(s)).sort();
    expect(orphans).not.toContain("etv-win");
    // A stock logo pack. Inert — an asset is only ever read via a union member's
    // stem, so these cost nothing but are listed rather than quietly deleted.
    expect(orphans).toEqual([
      "crunchyroll", "discovery-plus", "disney-plus", "espn-plus", "hulu",
      "max", "paramount-plus", "peacock", "youtube-tv",
    ]);
  });
});

describe("MINI-FILMS — no code excludes them, and none may start", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("the three runtime references in the codebase are SCORES, never filters", () => {
    for (const f of ["src/content/weekend/compare-picker.ts", "src/content/weekend/spotlight-picker.ts"]) {
      const src = code(read(f));
      for (const m of src.matchAll(/runtime\s*>=\s*\d+/g)) {
        // Each occurrence must sit in a `score +=` expression, not a filter or
        // an early return. A short film ranks lower; it is never dropped.
        const tail = src.slice(m.index!, m.index! + 60);
        expect(tail, `${f}: runtime comparison outside a score`).toMatch(/score \+=/);
      }
    }
  });

  it("NO module filters, rejects or returns early on runtime", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) { walk(rel); continue; }
        if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
        const src = code(read(rel));
        // A runtime comparison that is NOT part of a score is the thing that
        // would silently re-exclude mini-films.
        for (const m of src.matchAll(/runtime\s*(?:<|>|<=|>=)\s*\d+/g)) {
          if (!src.slice(m.index!, m.index! + 60).includes("score +=")) offenders.push(`${rel}: ${m[0]}`);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("the Wed Drop selection prompt no longer tells the model to skip shorts", () => {
    const src = read("src/content/weekend/wednesday-drop.ts");
    expect(src).not.toContain("not a real film — a short,");
    expect(src).toContain("MINI-FILMS AND SHORT FEATURES ARE IN SCOPE");
    expect(src).toContain("Runtime is NOT an eligibility test");
  });

  it("…but SERIES and non-film content are still excluded — movies-only stands", () => {
    const src = read("src/content/weekend/wednesday-drop.ts");
    expect(src).toContain("a SERIES or show");
    expect(src).toContain("a trailer or promo clip");
    expect(src).toContain("adult content");
  });
});
