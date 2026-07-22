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

/**
 * Phase 5.5 — fields a card template needs to style the platform-line in
 * the platform's brand color (or skip the color-up entirely).
 * Computed per-card in the orchestrator from the first platform of the
 * release. Falls back to brass when the platform has no token.
 */
export interface PlatformStyle {
  /** A CSS value: "var(--platform-netflix)" or "var(--brass)". Never empty. */
  platformColor: string;
  /** True only for JioHotstar — template renders gradient via background-clip:text. */
  platformIsGradient: boolean;
}

/**
 * Phase 5.5 — body-density tier for dynamic poster sizing.
 * Computed per-card by the orchestrator: shorter body → bigger poster.
 */
export type CardDensity = "compact" | "standard" | "dense";

/**
 * Phase 5.5 — enrichment fields a body card may carry beyond core release data.
 * Phase 5.6 — also carries releaseDates for the "RELEASED" section.
 * All optional; templates use smart-fallback conditionals to drop empty sections.
 */
export interface CardEnrichment {
  leadCast?: string[];               // top-2 billed actors from TMDb /credits
  musicDirector?: string;            // composer from TMDb /credits crew
  isMusicDirectorNotable?: boolean;  // LLM-judged; gates the "music by X" line
  audioLanguages?: {                 // film master audio tracks (TMDb spoken_languages)
    original: string;
    dubbed?: string[];
  };
  releaseDates?: {                   // IN-region dates from TMDb /release_dates
    theatrical?: string;             // type 2 or 3
    ott?: string;                    // type 4
  };
}

/**
 * Display-only seal state, resolved once by buildStampContext() and spread into
 * every body-card context. Three honest states so every card shows a seal:
 *   "tbsi" — curated TBSI blend  | "tmdb" — community-average fallback (muted)
 *   "new"  — no verdict yet (pending). stampLabel/stampScore/stampRingText drive
 *   the SVG; score/label collapse per state. Does NOT change how tbsiScore is computed.
 */
export interface StampContext {
  stampKind: "tbsi" | "tmdb" | "new";
  stampLabel?: string;
  stampScore?: string;
  stampRingText?: string;
  /** Phase 1 grounded Verdict seal — the ★/5 value shown PROMINENTLY (e.g. "4.1").
   *  When set, the seal renders ★{{stampStar}} (out of 5) instead of the /10
   *  stampScore number. Only the Sat Verdict grounded path sets it; other pillars
   *  leave it unset and the seal is unchanged. */
  stampStar?: string;
  /** "early" marks a low-confidence early read (vs a firm badge). */
  stampVariant?: "firm" | "early";
}

/** A single film card on a Sat Verdict body slide */
export interface SatVerdictCard extends CardEnrichment {
  filmTitle: string;
  language: string;
  platform: string[];
  platformLogos: string[];     // ["netflix", "jiohotstar"] — filename stems
  verdict: Verdict;
  verdictKind: "must-watch" | "worth-a-try" | "one-time-watch" | "skip";  // for template styling
  /** Long-title downsize hook: "title-sm" drops the title to 48px (see buildCard). */
  titleClass?: "title-sm";
  /** Top-strip buzz chip label — heat's absolute band relabelled AT DISPLAY TIME
   *  ONLY (HIGH BUZZ / WARM→MEDIUM BUZZ / QUIET→LOW BUZZ). Computed in buildCard
   *  via computeHeat(); ABSENT when heat is null (chip omitted, wordmark only).
   *  The relabel lives here in the render layer — heat.ts is untouched. */
  buzzLabel?: "HIGH BUZZ" | "MEDIUM BUZZ" | "LOW BUZZ";
  /** Bottom-strip cast receipts — UPPERCASE, " · "-joined, ≤3 lead names fit to a
   *  single line (trailing whole names dropped to fit). Computed in buildCard from
   *  leadCast (else first-3 cast); ABSENT when neither exists (hairline only). */
  castLine?: string;
  oneLineVerdict: string;
  watchIf: string;
  posterUrl?: string;
  fallbackColor: string;        // "#A33223" etc. when no poster
  runtime?: number;
  director?: string;
  cast: string[];
}

/** One poster tile on the Sat Verdict cover mosaic. Neutral + borderless — the
 *  verdict is no longer surfaced per-tile (moved to the masthead tally). */
export interface SatVerdictCoverTile {
  posterUrl?: string;
  fallbackColor: string;
  filmTitle: string;
  language: string;
}

/** One tier row in the masthead tally. The dot COLOR is chosen in the template
 *  CSS keyed off `key` (presentation stays in the template — same precedent as
 *  the buzz display map). Zero-count tiers are omitted upstream, so count ≥ 1. */
export interface SatVerdictTally {
  key: "mustwatch" | "try" | "onetime" | "skip";
  label: string;    // e.g. "MUST WATCH"
  count: number;    // films in the deck on this tier (≥ 1)
}

/**
 * Full context for the Sat Verdict cover slide (1080x1350) — a full-bleed poster
 * mosaic under an ink-veil masthead (eyebrow / WATCH OR SKIP / sub-line / date /
 * tally) with a raised bottom swipe cue. Per-tile verdict borders, the legend, the
 * old title block, and the issue № are gone; the cover teases the tally, not the
 * per-film answer.
 */
export interface SatVerdictCoverContext extends RenderBase {
  pillarLabel: "SAT VERDICT";
  /** Films split into mosaic rows by the renderer (e.g. 2/3/2 for 7). */
  gridRows: SatVerdictCoverTile[][];
  /** Per-tier counts (present tiers only, ladder order) for the masthead tally. */
  tally: SatVerdictTally[];
  /** N — number of films judged (= draft.verdicts.length), for the swipe cue. */
  filmCount: number;
  /** Run date formatted "JUL 11 · 2026" (no zero-padded day). */
  coverDate: string;
}

/** Full context for a Sat Verdict body card slide (1080x1080) */
export interface SatVerdictCardContext extends RenderBase, PlatformStyle {
  pillarLabel: "SAT VERDICT";
  card: SatVerdictCard;
  /** 1-indexed position in the carousel */
  slotNumber: number;
  totalSlots: number;
  /** Phase 5.5 — body-density tier (compact/standard/dense) */
  density: CardDensity;
  /** True when a SCORED seal (tbsi/tmdb) is shown, so the lower copy reserves
   *  the seal's right-hand pocket. (Replaces the old `{% if tbsiScore %}` gate,
   *  which never fired because tbsiScore wasn't in the card context.) */
  hasSeal: boolean;
  /** Display-only seal — see StampContext. Resolved by buildStampContext() for
   *  every card: "tbsi" (curated blend), "tmdb" (community-avg fallback), "new". */
  stampKind: "tbsi" | "tmdb" | "new";
  stampLabel?: string;
  stampScore?: string;
  stampRingText?: string;
  /** Grounded Verdict seal extras — see StampContext. */
  stampStar?: string;
  stampVariant?: "firm" | "early";
  // HEAT axis (🔥) is now relabelled to card.buzzLabel in buildCard and rendered
  // from the card (top strip). The old context-level `heat` field + its Heat
  // import were removed — no dead wiring. computeHeat() itself is unchanged.
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
  /** CSS object-position for the poster crop, e.g. "center 18%". Set only on
   *  the cover's top-4 grid items by the dark-crop safeguard; body cards ignore
   *  it. Defaults to "center 18%" in the template when unset. */
  cropPosition?: string;
}

/** Full context for the Wed Drop cover slide (1080x1350) */
export interface WedDropCoverContext extends RenderBase {
  pillarLabel: "WED DROP";
  /** Edition masthead label: "IN THEATERS" | "NOW STREAMING" (retained for
   *  parity with the card context; the redesigned cover no longer renders it —
   *  the edition reads from the plain h1 instead). */
  editionLabel: string;
  /** Plain edition h1, e.g. "This Week's OTT Drops." / "This Week's Theatrical
   *  Drops." Derived from the edition — no LLM copy. */
  coverTitle: string;
  /** Grid layout class for the poster wall: "count-1".."count-4" (top-4 cap). */
  gridClass: string;
  weekendDates: string;
  filmCount: number;
  /** Up to 4 films shown as a poster-wall grid (prominence order) */
  gridItems: WedDropGridItem[];
}

/** Full context for a Wed Drop body card slide (1080x1080) */
export interface WedDropCardContext extends RenderBase, PlatformStyle {
  pillarLabel: "WED DROP";
  /** Edition masthead label: "IN THEATERS" | "NOW STREAMING" */
  editionLabel: string;
  /** From LLM: title (= film title) + body (= why this matters) */
  title: string;
  body: string;
  /** Linked Release data for poster + metadata */
  release: WedDropGridItem & CardEnrichment & {
    director?: string;
    cast: string[];
    runtime?: number;
  };
  slotNumber: number;
  totalSlots: number;
  /** Phase 5.5 — body-density tier (compact/standard/dense) */
  density: CardDensity;
  /** Display-only seal — see StampContext. Resolved by buildStampContext() for
   *  every card: "tbsi" (curated blend), "tmdb" (community-avg fallback), "new". */
  stampKind: "tbsi" | "tmdb" | "new";
  stampLabel?: string;
  stampScore?: string;
  stampRingText?: string;
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
export interface MonMovementCardContext extends RenderBase, PlatformStyle {
  pillarLabel: "MON MOVEMENT";
  title: string;             // from slide.title
  body: string;              // from slide.body
  release: MonMovementGridItem & CardEnrichment & {
    director?: string;
    cast: string[];
    runtime?: number;
  };
  slotKind: "arrival" | "gem";   // determines accent color + copy
  slotNumber: number;
  totalSlots: number;
  /** Phase 5.5 — body-density tier (compact/standard/dense) */
  density: CardDensity;
  /** Display-only seal — see StampContext. Resolved by buildStampContext() for
   *  every card: "tbsi" (curated blend), "tmdb" (community-avg fallback), "new". */
  stampKind: "tbsi" | "tmdb" | "new";
  stampLabel?: string;
  stampScore?: string;
  stampRingText?: string;
}

// ============================================================
// Sun Spotlight — Gallery aesthetic
// Single context shared across 4 templates: feed cover (1080x1350),
// reel cover (1080x1920), card-why-it-works + card-case-against (1080x1080).
// ============================================================

export interface SunSpotlightRenderContext extends PlatformStyle, CardEnrichment {
  // Cover-level
  filmTitle: string;
  language: string;
  director?: string;
  runtime?: number;
  posterUrl?: string;
  posterFallbackColor: string;
  hook: string;
  issueNumber: string;       // "044"
  /** THE pixel date, "MMM D · YYYY" (e.g. "MAY 31 · 2026"). Named coverDate,
   *  not issueDate: it is a DATE, and nothing issue-numbered reaches pixels. */
  coverDate: string;

  // Card 1 (whyItWorks)
  whyItWorks: string;
  platform: string;          // first platform name, e.g. "SonyLIV"
  platformLogoStem: string;  // filename stem, e.g. "sony-liv"

  // Card 2 (caseAgainstSkepticism)
  caseAgainstSkepticism: string;
  ctaTagline: string;

  /** Phase 5.5 — body-density tier (compact/standard/dense), applies to card 1 only */
  density: CardDensity;
  /** Display-only seal — see StampContext. Resolved by buildStampContext()
   *  (rendered only on the why-it-works card): "tbsi" / "tmdb" / "new". */
  stampKind: "tbsi" | "tmdb" | "new";
  stampLabel?: string;
  stampScore?: string;
  stampRingText?: string;
}