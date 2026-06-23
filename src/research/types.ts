// src/research/types.ts
// Shared shapes for the internal research module. No I/O here — pure types.

export type SourceName = "wikipedia" | "googleNews" | "reddit" | "youtube" | "brave";

/** facts = encyclopedic/ground-truth, signal = buzz/coverage, both = either. */
export type SourceKind = "facts" | "signal" | "both";

export interface ResearchQuery {
  title: string;
  year?: number;
  language?: string;
  imdbId?: string;
  tmdbId?: number;
  freeText?: string;
}

export interface RawSourceItem {
  title?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}

export interface RawSourceResult {
  source: SourceName;
  kind: SourceKind;
  ok: boolean;
  items: RawSourceItem[];
  /** The unshaped upstream payload, kept for debugging / later tuning. */
  raw?: unknown;
  /**
   * Source-level extras a consumer can read without iterating items — e.g.
   * youtube's headline { maxViewCount }. Optional and sort-independent; the
   * no-key sources leave it unset.
   */
  meta?: Record<string, unknown>;
  fetchedAt: string;
  /** True when every HTTP call backing this result was a fresh cache hit. */
  cached?: boolean;
  error?: string;
}

export interface ResearchResult {
  query: ResearchQuery;
  results: RawSourceResult[];
  ranAt: string;
}

export interface ResearchSource {
  name: SourceName;
  kind: SourceKind;
  requiresKey: boolean;
  isAvailable(): boolean;
  query(q: ResearchQuery): Promise<RawSourceResult>;
}

// ──────────────────────────────────────────────────────────────────────────
// Consolidation (Step 3) — the LLM turns a ResearchResult into this structured,
// provenance-tagged shape. DATA ONLY: no caption, no editorial voice. Every
// field carries which source(s) support it and a confidence. All facts/signal
// fields are OPTIONAL — overlooked films are legitimately sparse; a missing
// field means "not found in the sources", never "fabricate it".
// ──────────────────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low";

/** A single consolidated value with provenance + confidence. */
export interface ConsolidatedField<T> {
  value: T;
  /** Which source(s) the value was drawn from. */
  sources: SourceName[];
  confidence: Confidence;
  /** Optional caveat (e.g. thin/indirect/conflicting). */
  note?: string;
}

/** Objective, verifiable facts — each traceable to a provided source. */
export interface ConsolidatedFacts {
  title?: ConsolidatedField<string>;
  year?: ConsolidatedField<number>;
  languages?: ConsolidatedField<string[]>;
  director?: ConsolidatedField<string>;
  cast?: ConsolidatedField<string[]>;
  musicDirector?: ConsolidatedField<string>;
  releaseDate?: ConsolidatedField<string>;
  runtime?: ConsolidatedField<string>;
  genres?: ConsolidatedField<string[]>;
  synopsis?: ConsolidatedField<string>;
  boxOffice?: ConsolidatedField<string>;
}

/** Interpreted signal — reception nuance, buzz, discoverability, controversies. */
export interface ConsolidatedSignal {
  criticalReception?: ConsolidatedField<string>;
  audienceBuzz?: ConsolidatedField<string>;
  discoverability?: ConsolidatedField<string>;
  controversies?: ConsolidatedField<string>;
  notes?: ConsolidatedField<string[]>;
}

/** An item the model judged to be about a DIFFERENT film/topic (name-drop). */
export interface DiscardedItem {
  title?: string;
  url?: string;
  source: SourceName;
  reason: string;
}

export interface ConsolidatedResearch {
  query: { title: string; year?: number };
  facts: ConsolidatedFacts;
  signal: ConsolidatedSignal;
  discarded: DiscardedItem[];
  /** Model id that produced this (reflects the FIRST consolidation). */
  model: string;
  /** ISO timestamp of the FIRST consolidation (so staleness is visible). */
  consolidatedAt: string;
  /** True when served from cache (stamped fresh each call, not cached itself). */
  cached?: boolean;
}
