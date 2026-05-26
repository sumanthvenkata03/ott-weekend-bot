// src/rendering/types.ts
// Data shapes each pillar's templates consume.
// Renderers build these from the bot's existing draft objects.

import type { Release, Verdict } from "../shared/types.js";
import type { SaturdayVerdictDraft, VerdictSlide } from "../delivery/notion.js";
import type { WednesdayDropDraft, WedDropSlide } from "../delivery/notion.js";
import type { MovementDraft, MovementSlide } from "../delivery/notion.js";

/** Common fields every render context carries */
export interface RenderBase {
  /** "01" — issue volume, currently always Vol 01 */
  vol: string;
  /** "042" — sequential issue number, 3-digit padded */
  issue: string;
  /** ISO date YYYY-MM-DD — when this issue was generated */
  date: string;
  /** "13·05·26" formatted date for display */
  displayDate: string;
  /** Pillar identifier for the masthead */
  pillarLabel: string;
}

/** A single film card on a Sat Verdict body slide */
export interface SatVerdictCard {
  filmTitle: string;
  language: string;
  platform: string[];
  platformLogos: string[];     // ["netflix", "jiohotstar"] — filename stems
  verdict: Verdict;
  verdictKind: "must-watch" | "worth-a-try" | "skip";  // for template styling
  oneLineVerdict: string;
  watchIf: string;
  posterUrl?: string;
  fallbackColor: string;        // "#A33223" etc. when no poster
  runtime?: number;
  director?: string;
  cast: string[];
}

/** Full context for the Sat Verdict cover slide (1080x1350) */
export interface SatVerdictCoverContext extends RenderBase {
  pillarLabel: "SAT VERDICT";
  hotTake: string;
  filmCount: number;
  weekendDates: string;
  /** Hero film for the cover (the Must Watch with highest priority) */
  hero: SatVerdictCard;
}

/** Full context for a Sat Verdict body card slide (1080x1080) */
export interface SatVerdictCardContext extends RenderBase {
  pillarLabel: "SAT VERDICT";
  card: SatVerdictCard;
  /** 1-indexed position in the carousel */
  slotNumber: number;
  totalSlots: number;
}

// ============================================================
// Wed Drop — Newspaper Grid mode
// ============================================================



/** A poster + label combo for the cover grid */
export interface WedDropGridItem {
  filmTitle: string;
  language: string;
  platform: string[];
  platformLogos: string[];     // ["netflix", "jiohotstar"] — filename stems
  posterUrl?: string;
  fallbackColor: string;
}

/** Full context for the Wed Drop cover slide (1080x1350) */
export interface WedDropCoverContext extends RenderBase {
  pillarLabel: "WED DROP";
  weekendDates: string;
  filmCount: number;
  /** From LLM: 6-word headline + subtext (slide 1 in carouselSlides) */
  coverHeadline: string;
  coverSubtext: string;
  /** Up to 4 films shown as a 2x2 grid */
  gridItems: WedDropGridItem[];
}

/** Full context for a Wed Drop body card slide (1080x1080) */
export interface WedDropCardContext extends RenderBase {
  pillarLabel: "WED DROP";
  /** From LLM: title (= film title) + body (= why this matters) */
  title: string;
  body: string;
  /** Linked Release data for poster + metadata */
  release: WedDropGridItem & {
    director?: string;
    cast: string[];
    runtime?: number;
  };
  slotNumber: number;
  totalSlots: number;
}

// ============================================================
// Mon Movement — Newspaper Grid + arrival/gem dual-mode
// ============================================================

export interface MonMovementGridItem {
  filmTitle: string;
  language: string;
  platform: string[];
  platformLogos: string[];     // ["netflix", "jiohotstar"] — filename stems
  posterUrl?: string;
  fallbackColor: string;
  isGem: boolean;  // true for hiddenGems, false for newArrivals
}

/** Full context for the Mon Movement cover slide (1080x1350) */
export interface MonMovementCoverContext extends RenderBase {
  pillarLabel: "MON MOVEMENT";
  weekLabel: string;
  weekHeadline: string;       // the LLM's pattern-recognition line, the post's spine
  arrivalCount: number;
  gemCount: number;
  coverHeadline: string;      // from cover slide title
  coverSubtext: string;       // from cover slide body
  gridItems: MonMovementGridItem[];  // up to 4 for the cover grid (arrivals first, gems to fill)
}

/** Full context for a Mon Movement body card slide (1080x1080) */
export interface MonMovementCardContext extends RenderBase {
  pillarLabel: "MON MOVEMENT";
  title: string;             // from slide.title
  body: string;              // from slide.body
  release: MonMovementGridItem & {
    director?: string;
    cast: string[];
    runtime?: number;
  };
  slotKind: "arrival" | "gem";   // determines accent color + copy
  slotNumber: number;
  totalSlots: number;
}

// ============================================================
// Sun Spotlight — Gallery aesthetic
// Single context shared across 4 templates: feed cover (1080x1350),
// reel cover (1080x1920), card-why-it-works + card-case-against (1080x1080).
// ============================================================

export interface SunSpotlightRenderContext {
  // Cover-level
  filmTitle: string;
  language: string;
  director?: string;
  runtime?: number;
  posterUrl?: string;
  posterFallbackColor: string;
  hook: string;
  issueNumber: string;       // "044"
  issueDate: string;         // "31·05·26"

  // Card 1 (whyItWorks)
  whyItWorks: string;
  platform: string;          // first platform name, e.g. "SonyLIV"
  platformLogoStem: string;  // filename stem, e.g. "sony-liv"

  // Card 2 (caseAgainstSkepticism)
  caseAgainstSkepticism: string;
  ctaTagline: string;
}