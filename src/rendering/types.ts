// src/rendering/types.ts
// Data shapes each pillar's templates consume.
// Renderers build these from the bot's existing draft objects.

import type { Release, Verdict } from "../shared/types.js";
import type { SaturdayVerdictDraft, VerdictSlide } from "../delivery/notion.js";

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