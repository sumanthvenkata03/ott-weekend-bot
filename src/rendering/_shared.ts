// src/rendering/_shared.ts
// Tiny helpers shared by the 4 pillar render orchestrators (Phase 5.5).
//
// Owns two concerns:
//   1. Platform → brand color/gradient mapping (PlatformStyle)
//   2. Card density tier (CardDensity)
//
// Both are pure functions — easy to test, no I/O.

import { differenceInCalendarDays, parseISO } from "date-fns";
import type { PlatformStyle, CardDensity, CardEnrichment, StampContext } from "./types.js";

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

/**
 * TMDb community-average vote floor. Below this, a TMDb average is a handful of
 * votes — noise, not a verdict — so we fall through to the "new" state instead.
 * Tunable; 50 is a conservative "enough people weighed in" line.
 */
export const TMDB_FALLBACK_MIN_VOTES = 50;

/** Structural subset of Release that buildStampContext reads — all optional so
 *  the Sat path (where the linked release may be missing) can pass undefined. */
type StampInput = {
  tbsiScore?: number;
  imdbRating?: number;
  rottenTomatoes?: number;
  metacritic?: number;
  letterboxd?: number;
  tmdbVoteAverage?: number;
  tmdbVoteCount?: number;
  releaseDate?: string;
};

/** True when releaseDate is within ~10 days of today or in the future. */
function isRecentRelease(releaseDate: string | undefined): boolean {
  if (!releaseDate) return false;
  try {
    return differenceInCalendarDays(new Date(), parseISO(releaseDate)) <= 10;
  } catch {
    return false;
  }
}

/**
 * Resolve the honest seal state for a release (display-only — does NOT change
 * how tbsiScore is computed). Priority:
 *   1. "tbsi" — curated TBSI blend exists (release.tbsiScore defined).
 *   2. "tmdb" — no blend, but a TMDb community average that clears
 *               TMDB_FALLBACK_MIN_VOTES votes. Rendered MUTED (secondary source).
 *   3. "new"  — no verdict yet. Recency picks the wording: a just-released /
 *               upcoming film reads "NEW", an older unrated title reads "UNRATED".
 * Always returns a stampKind, so every card shows a seal.
 */
export function buildStampContext(release: StampInput | undefined): StampContext {
  if (release && release.tbsiScore !== undefined) {
    return {
      stampKind: "tbsi",
      stampLabel: "TBSI",
      stampScore: release.tbsiScore.toFixed(1),
      stampRingText: buildTbsiRingText(release),
    };
  }
  if (
    release &&
    typeof release.tmdbVoteAverage === "number" &&
    (release.tmdbVoteCount ?? 0) >= TMDB_FALLBACK_MIN_VOTES
  ) {
    return {
      stampKind: "tmdb",
      stampLabel: "TMDb",
      stampScore: release.tmdbVoteAverage.toFixed(1),
      stampRingText: `${release.tmdbVoteCount} VOTES`,
    };
  }
  const recent = isRecentRelease(release?.releaseDate);
  return {
    stampKind: "new",
    stampLabel: recent ? "NEW" : "UNRATED",
    stampRingText: recent ? "JUST DROPPED · NO VERDICT YET" : "NO VERDICT YET",
  };
}
