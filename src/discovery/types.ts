// src/discovery/types.ts
// Type contracts for the standalone film-discovery engine.
//
// The engine FINDS films released in a date range by unioning two
// independent "nets" — TMDb discover + Wikipedia year-lists — and flags
// what each net missed. No LLM, purely additive to the rest of the app.

/** The independent discovery nets.
 *  - "tmdb" / "wikipedia": the algorithmic nets (no LLM).
 *  - "ai-ott": the AI-search OTT net (Tavily + Claude extract → TMDb resolve) —
 *    finds press-confirmed OTT releases TMDb's release_type=4 net misses. */
export type DiscoverySource = "tmdb" | "wikipedia" | "ai-ott";

/**
 * How TMDb surfaced a film in the date range:
 *  - "theatrical": matched the primary_release_date pass
 *  - "digital":    matched only the with_release_type=4 (OTT) pass
 *  - "both":       matched both passes (same tmdbId)
 */
export type ReleaseType = "theatrical" | "digital" | "both";

/** Per-net raw detail kept on a merged film (for provenance/debugging). */
export interface TmdbSourceDetail {
  tmdbId: number;
  title: string;
  releaseDate?: string;
  language?: string;
  releaseType?: ReleaseType;
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
  /** True when the date is fuzzy (month-only, or a digital hit dated by its TMDb primary date). */
  approximateDate?: boolean;
  /** Theatrical / digital / both — only set for films the TMDb net found. */
  releaseType?: ReleaseType;
  tmdbId?: number;
  /** Human-readable caveat (e.g. why a date is approximate). */
  note?: string;
  /**
   * Set when this film shares its dedupe key (normalizedTitle|language|year)
   * with another film carrying a DIFFERENT tmdbId — i.e. they are almost
   * certainly distinct films (a remake / same-title same-year namesake) that
   * the union refused to merge. Both colliding films carry the flag so the
   * collision can be surfaced rather than silently swallowed.
   */
  possibleDistinct?: boolean;
  /** Press-sourced OTT (digital) release date from the AI-search net — the date
   *  TMDb's release_type=4 net misses (the Blast case). Maps to
   *  Release.releaseDates.ott during adaptation. */
  ottDate?: string;
  /** OTT platform name from the AI-search net (e.g. "Netflix"), when stated. */
  platform?: string;
  /** A supporting source URL from the AI-search net (provenance). */
  sourceUrl?: string;
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

/** Per-(language, year) coverage from the TMDb net. */
export interface TmdbCoverage {
  language: string;
  year: number;
  count: number;
}

/** Per-(language, year) coverage from the Wikipedia net. */
export interface WikiCoverage {
  language: string;
  year: number;
  /** "ok" = page existed & parsed; "missing" = 404/not created; "error" = fetch/parse threw. */
  status: "ok" | "missing" | "error";
  count: number;
}

/** A net's result: the films it found plus its per-(language, year) coverage. */
export interface TmdbNetResult {
  films: DiscoveredFilm[];
  coverage: TmdbCoverage[];
}
export interface WikiNetResult {
  films: DiscoveredFilm[];
  coverage: WikiCoverage[];
}

/** Coverage statistics — the "miss detection" lives here. */
export interface DiscoveryStats {
  // Partial: a given run only populates the nets it ran (discover() reports tmdb
  // + wikipedia; the ai-ott net is unioned in later at the getCandidates layer).
  perNet: Partial<Record<DiscoverySource, number>>;
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
