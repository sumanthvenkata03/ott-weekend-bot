// src/rendering/_shared.ts
// Tiny helpers shared by the 4 pillar render orchestrators (Phase 5.5).
//
// Owns two concerns:
//   1. Platform → brand color/gradient mapping (PlatformStyle)
//   2. Card density tier (CardDensity)
//
// Both are pure functions — easy to test, no I/O.

import type { PlatformStyle, CardDensity, CardEnrichment } from "./types.js";

/**
 * Map a platform display name (e.g. "Netflix", "Prime Video") to the
 * CSS color value that should drive its card's platform-line styling.
 *
 * - Returns var(--platform-X) for the 8 platforms with brand tokens.
 * - Returns var(--brass) as a graceful fallback for anything else.
 * - JioHotstar gets platformIsGradient=true so the template renders the
 *   gradient via background-clip:text instead of a flat color.
 *
 * The platform name MUST come from src/shared/types.ts Platform enum
 * (which maps from TMDb provider names via PROVIDER_MAP in tmdb.ts).
 */
export function getPlatformStyle(platform: string | undefined): PlatformStyle {
  const map: Record<string, string> = {
    "Netflix":      "var(--platform-netflix)",
    "Prime Video":  "var(--platform-prime-video)",
    "Aha":          "var(--platform-aha)",
    "SonyLIV":      "var(--platform-sony-liv)",
    "ZEE5":         "var(--platform-zee5)",
    "Apple TV+":    "var(--platform-apple-tv)",
    "Hulu":         "var(--platform-hulu)",
    "ETV Win":      "var(--platform-etv-win)",
  };
  if (platform === "JioHotstar") {
    return { platformColor: "var(--platform-jiohotstar-end)", platformIsGradient: true };
  }
  return {
    platformColor: map[platform ?? ""] ?? "var(--brass)",
    platformIsGradient: false,
  };
}

/**
 * Compute a card's body-density tier from its text content.
 *
 * Light cards → poster takes more room (compact).
 * Heavy cards → poster shrinks to give text room (dense).
 *
 * Line weights reflect the actual visual mass each line consumes on the
 * card:
 *   Line 1 ("Telugu · 142 min · dir. ...") — full Playfair italic at 20px,
 *     usually fills the column → counts ~80 chars.
 *   Line 2 ("with X, Y, music by Z")      — Inter 14-15px at 0.7 opacity,
 *     visually quieter and often shorter → counts ~40 chars (half-weight).
 *
 * Thresholds tuned post-review so borderline cards land in the right tier:
 *   < 180 chars total → compact   (Sathi Leelavathi w/ no Line 1 lands here)
 *   180–280          → standard
 *   > 280            → dense      (Bhishmar with full metadata + long body)
 */
export function computeDensity(args: {
  bodyLength: number;
  hasLine1: boolean;       // language · runtime · dir
  hasLine2: boolean;       // with cast, music by …
}): CardDensity {
  const line1Chars = args.hasLine1 ? 80 : 0;
  const line2Chars = args.hasLine2 ? 40 : 0;
  const total = args.bodyLength + line1Chars + line2Chars;
  if (total < 180) return "compact";
  if (total > 280) return "dense";
  return "standard";
}

/**
 * Phase 5.5 helper — does the card have enough metadata to render Line 1
 * (language · runtime · dir.)? Per the Phase 4 backlog rule, Line 1 drops
 * if neither runtime nor director is present.
 */
export function hasMetadataLine1(release: { runtime?: number; director?: string }): boolean {
  return Boolean(release.runtime || release.director);
}

/**
 * Phase 5.5 helper — does the card have enough enrichment to render Line 2
 * (with X, music by Y)? Line 2 drops if neither leadCast nor a notable
 * music director is present.
 */
export function hasMetadataLine2(release: CardEnrichment): boolean {
  const hasCast = Boolean(release.leadCast && release.leadCast.length > 0);
  const hasMusic = Boolean(release.musicDirector && release.isMusicDirectorNotable);
  return hasCast || hasMusic;
}
