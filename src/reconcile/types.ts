// src/reconcile/types.ts
// Shared shapes for the Wed Drop reconciliation layer. No I/O here — pure types.
//
// Provenance discipline (locked): the AI-search net contributes
// title / language-hint / platform / date / source ONLY. Cast, poster, and the
// canonical title ALWAYS come from TMDb — never the LLM. A film with no TMDb
// match stays "unverified" and carries title + source only (no fabricated
// fields), and is hard-pinned 🔴 (cannot pass the gate, even in auto mode).

import type { Release } from "../shared/types.js";
import type { WedDropEdition } from "../shared/wed-drop-edition.js";

/** Review tier. green = clean + cross-net corroborated, yellow = one issue, red = blocked. */
export type Tier = "green" | "yellow" | "red";

/** A snippet citation the LLM must attach to every extracted film. */
export interface ExtractedSource {
  url: string;
  snippet?: string;
}

/**
 * One film as extracted from the AI-net snippets. The LLM may ONLY populate
 * title / language / platform / date / source / confidence — never cast,
 * synopsis, or poster (those come from TMDb downstream). `sources` is required
 * (>=1) so nothing is ever emitted without provenance.
 */
export interface ExtractedFilm {
  title: string;
  language?: string;
  platform?: string;
  date?: string;
  /** Every distinct date the snippets attach to this film — so conflicts are visible. */
  datesSeen?: string[];
  isSeries: boolean;
  sources: ExtractedSource[];
  confidence?: "high" | "medium" | "low";
}

/**
 * A rejected lead, surfaced in the review for auditability. `reason` is the
 * category (e.g. "series", "non-Indian-language"); originalLanguage + sourceUrl
 * are carried when known so a reviewer can see WHY without re-deriving it.
 */
export interface RejectedExtraction {
  title?: string;
  reason: string;
  originalLanguage?: string;
  sourceUrl?: string;
}

export interface DateConflictExtraction {
  title?: string;
  datesSeen?: string[];
  note?: string;
}

/** Full output of ONE per-edition extraction call (the only new LLM use). */
export interface ExtractionResult {
  films: ExtractedFilm[];
  rejected: RejectedExtraction[];
  dateConflict: DateConflictExtraction[];
}

/** Resolution status after the TMDb cross-check. */
export type ReconStatus = "confirmed" | "unverified" | "series-rejected";

/** Landing-window verdict, mirroring the post-validator's pass/warn/fail. */
export type LandingStatus = "pass" | "warn" | "fail";

/**
 * One reconciled, provenance-tagged, tiered film — the review payload AND the
 * unit the gate decides on. `release` is the Release record fed to the renderer
 * (absent for unverified / series — they carry title + source only).
 */
export interface ReconciledFilm {
  // Identity / display
  tmdbId?: number;
  title: string;              // display title (TMDb canonical when resolved, else AI title)
  language: string;
  pillar: WedDropEdition;

  // AI-net contributed (title / platform / date / source only)
  platform?: string;
  date?: string;
  dateSource: "tmdb" | "press" | "none";
  sourceUrl?: string;
  confidence?: "high" | "medium" | "low";

  // Provenance + tier
  foundIn: string[];          // subset of ["tmdb","ai-net"]
  status: ReconStatus;
  landingStatus?: LandingStatus;
  /** The precise landing-check reason from assessDates (e.g. "no qualifying date"). */
  landingReason?: string;
  tier: Tier;
  reasons: string[];          // human-readable "why this tier"

  // Flags
  possibleDuplicate?: boolean;
  ambiguousMatch?: boolean;
  ottDateFromPress?: boolean;
  wasBelowCap?: boolean;
  conflictDetail?: string;

  // TMDb-resolved enrichment (NEVER from the LLM)
  resolvedTitle?: string;
  posterUrl?: string;
  cast?: string[];
  year?: number;

  // The renderer-bound record (absent for unverified / series).
  release?: Release;
}

export interface ReconcileCounts {
  total: number;
  green: number;
  yellow: number;
  red: number;
  addedByAiNet: number;       // real films TMDb discovery missed (ai-net only, confirmed)
  flagged: number;            // yellow + red
}

export interface ReconcileResult {
  pillar: WedDropEdition;
  window: { start: string; end: string };
  reconciled: ReconciledFilm[];          // full annotated list (augment-only; nothing dropped)
  rejected: RejectedExtraction[];        // series / non-film / non-Indian-language
  counts: ReconcileCounts;
}
