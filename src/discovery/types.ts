// src/discovery/types.ts
// Type contracts for the standalone film-discovery engine.
//
// The engine FINDS films released in a date range by unioning two
// independent "nets" — TMDb discover + Wikipedia year-lists — and flags
// what each net missed. No LLM, purely additive to the rest of the app.

/** The independent discovery nets. */
export type DiscoverySource = "tmdb" | "wikipedia";

/** Per-net raw detail kept on a merged film (for provenance/debugging). */
export interface TmdbSourceDetail {
  tmdbId: number;
  title: string;
  releaseDate?: string;
  language?: string;
}

export interface WikipediaSourceDetail {
  title: string;
  releaseDate?: string;
  approximateDate?: boolean;
  language?: string;
  page: string;
}

/** A single film discovered by one or both nets. */
export interface DiscoveredFilm {
  /** Display title, preserved verbatim from the net that found it. */
  title: string;
  /** Lowercased/diacritic-stripped key used only for dedupe. */
  normalizedTitle: string;
  year?: number;
  /** Human language name (e.g. "Telugu"). */
  language?: string;
  /** ISO yyyy-mm-dd when concrete; first-of-month when approximate. */
  releaseDate?: string;
  /** True when only a month was known (day inferred) — date is fuzzy. */
  approximateDate?: boolean;
  tmdbId?: number;
  /** Which nets surfaced this film. */
  foundIn: DiscoverySource[];
  /** Raw per-net details for provenance. */
  perSource: {
    tmdb?: TmdbSourceDetail;
    wikipedia?: WikipediaSourceDetail;
  };
}

/** What to discover. from/to are inclusive ISO yyyy-mm-dd bounds. */
export interface DiscoveryQuery {
  from: string;
  to: string;
  /** Human language names (e.g. ["Telugu","Tamil"]). */
  languages: string[];
}

/** Coverage statistics — the "miss detection" lives here. */
export interface DiscoveryStats {
  perNet: Record<DiscoverySource, number>;
  unionCount: number;
  onlyInTmdb: number;
  onlyInWikipedia: number;
  inBoth: number;
}

/** Full result of a discovery run. */
export interface DiscoveryResult {
  query: DiscoveryQuery;
  films: DiscoveredFilm[];
  stats: DiscoveryStats;
  /** ISO timestamp the run finished. */
  ranAt: string;
}
