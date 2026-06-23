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
