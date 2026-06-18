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
 * Line weights reflect the visual mass each section consumes on the card:
 *   Line 1 ("Telugu · 142 min · dir. ...") — Playfair italic at 20px,
 *     usually fills the column → counts ~80 chars.
 *   Line 2 ("with X, Y, music by Z")      — Inter 14-15px at 0.7 opacity,
 *     visually quieter and often shorter → ~40 chars (half-weight).
 *   RELEASED section ("★ RELEASED" + one date line)        → ~60 chars.
 *   AVAILABLE IN section ("★ AVAILABLE IN" + pill row)     → ~50 chars.
 *
 * Thresholds (kept from Phase 5.5 — may need retune as Phase 5.6 sections
 * become common):
 *   < 180 chars total → compact
 *   180–280          → standard
 *   > 280            → dense
 */
export function computeDensity(args: {
  bodyLength: number;
  hasLine1: boolean;        // language · runtime · dir
  hasLine2: boolean;        // with cast, music by …
  hasReleased?: boolean;    // ★ RELEASED section (Phase 5.6)
  hasLanguages?: boolean;   // ★ AVAILABLE IN section (Phase 5.6)
}): CardDensity {
  const line1Chars     = args.hasLine1     ? 80 : 0;
  const line2Chars     = args.hasLine2     ? 40 : 0;
  const releasedChars  = args.hasReleased  ? 60 : 0;
  const languagesChars = args.hasLanguages ? 50 : 0;
  const total =
    args.bodyLength + line1Chars + line2Chars + releasedChars + languagesChars;
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

/**
 * Phase 5.6 helper — does the card have a "★ RELEASED" section to render?
 * True when at least one of theatrical or OTT release date is present.
 */
export function hasReleasedSection(release: CardEnrichment): boolean {
  return Boolean(
    release.releaseDates &&
      (release.releaseDates.theatrical || release.releaseDates.ott)
  );
}

/**
 * Phase 5.6 helper — does the card have an "★ AVAILABLE IN" pill row?
 * True when audioLanguages has at least the original track (the row would
 * be one filled pill even without dubs — still worth surfacing).
 */
export function hasLanguagesSection(release: CardEnrichment): boolean {
  return Boolean(release.audioLanguages && release.audioLanguages.original);
}

/**
 * TBSI stamp — bottom-arc text: only the ratings that exist, joined by " · "
 * in a fixed order (IMDb, RT%, MC, LB). Values are shown as-is (the tbsiScore
 * itself is formatted to 1 decimal by the caller). Returns "" if none present.
 *   4 sources → "IMDb 8.8 · RT 87% · MC 74 · LB 4.2"
 *   1 source  → "IMDb 6.9"
 */
export function buildTbsiRingText(release: {
  imdbRating?: number;
  rottenTomatoes?: number;
  metacritic?: number;
  letterboxd?: number;
}): string {
  const parts: string[] = [];
  if (typeof release.imdbRating === "number") parts.push(`IMDb ${release.imdbRating.toFixed(1)}`);
  if (typeof release.rottenTomatoes === "number") parts.push(`RT ${release.rottenTomatoes}%`);
  if (typeof release.metacritic === "number") parts.push(`MC ${release.metacritic}`);
  if (typeof release.letterboxd === "number") parts.push(`LB ${release.letterboxd.toFixed(1)}`);
  return parts.join(" · ");
}
