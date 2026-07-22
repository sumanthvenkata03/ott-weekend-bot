// src/shared/types.ts

export type Language = 
  | "Hindi" | "Telugu" | "Tamil" | "Malayalam" 
  | "Kannada" | "Marathi" | "Bengali" | "Punjabi" | "Other";

export type Platform = 
  | "Netflix" | "Prime Video" | "JioHotstar" | "Aha" | "SonyLIV" 
  | "ZEE5" | "Sun NXT" | "ManoramaMAX" | "Hoichoi" | "Lionsgate Play"
  | "Apple TV+" | "MUBI" | "Chaupal" | "Planet Marathi" | "Other";

export type Mood = 
  | "Light Watch" | "Mind-Bender" | "Emotional" | "Action-Packed"
  | "Romantic" | "Horror" | "Comedy" | "Thriller";

export type FamilyFilter = 
  | "Solo" | "Date Night" | "Family with Kids" 
  | "With Parents" | "Avoid with Family";

export type Verdict = "🔥 Must Watch" | "👀 Worth a Try" | "🎟️ One-Time Watch" | "⏭️ Skip" | "Pending";

/** A normalized OTT release across all sources */
export interface Release {
  // Identity
  id: string;                    // our internal ID (hash of tmdbId + platform)
  tmdbId?: number;
  imdbId?: string;
  
  // Core metadata
  title: string;
  originalTitle?: string;        // for non-Latin scripts
  language: Language;
  isSeries: boolean;
  
  // Release info
  platform: Platform[];          // can be on multiple
  releaseDate: string;           // ISO date YYYY-MM-DD — generic (TMDb primary)
  theatricalReleaseDate?: string;
  /**
   * Phase 5.6 — IN-region release dates from TMDb /movie/{id}/release_dates.
   * theatrical: type 2 or 3 (limited or wide) for India
   * ott: type 4 (digital) for India
   * Either or both may be missing; the card template drops the "RELEASED"
   * section if neither is present.
   */
  releaseDates?: {
    theatrical?: string;  // ISO date YYYY-MM-DD
    ott?: string;         // ISO date YYYY-MM-DD
  };
  /**
   * R2 — set when releaseDates.theatrical was BACKFILLED from the discover
   * `releaseDate` because TMDb carried no IN release_dates row (the Chennai
   * Love Story case). The date is real; its provenance is weaker, so the
   * manifest warns rather than silently presenting it as an IN-region date.
   */
  releaseDatesFallback?: "discover";
  
  // Content
  genre: string[];
  runtime?: number;              // minutes (for films)
  episodeCount?: number;         // for series
  director?: string;
  cast: string[];                // top 3-5 (from OMDb Actors)
  leadCast?: string[];           // top 2 by TMDb billing order (Phase 5.5)
  musicDirector?: string;        // composer from TMDb /credits (Phase 5.5)
  synopsis: string;
  posterUrl?: string;
  backdropUrl?: string;

  // Localization (Phase 5.5: structured shape)
  // original: display name of the film's primary audio language
  // dubbed: other languages the film exists in (excludes original)
  // Caveat: sourced from TMDb spoken_languages — tied to the film master,
  // not to a specific OTT platform's copy.
  audioLanguages?: {
    original: string;
    dubbed?: string[];
  };
  subtitleLanguages: string[];
  
  // Ratings (populated by MDBList primary + OMDb fallback in a later step)
  imdbRating?: number;
  imdbVotes?: number;
  rottenTomatoes?: number;       // RT critic % (kept name to avoid churn)
  rtAudience?: number;           // RT audience % (MDBList "popcorn")
  metacritic?: number;           // 0–100
  letterboxd?: number;           // 0–5
  /** Coverage-aware composite blended across available ratings (see mdblist.ts). */
  tbsiScore?: number;            // 0–10, rounded to 1 decimal
  tbsiSourceCount?: number;      // how many sources contributed to tbsiScore

  // TMDb buzz signals (from the discover result) — used to surface unrated
  // brand-new arrivals by curiosity when no IMDb rating exists yet.
  tmdbPopularity?: number;
  tmdbVoteAverage?: number;
  tmdbVoteCount?: number;
  
  // Tagging (populated by LLM later)
  mood?: Mood[];
  familyFilter?: FamilyFilter[];
  verdict?: Verdict;
  hypeScore?: number;            // 0-100, populated in Week 2
  
  // Provenance
  sources: string[];             // which APIs/sites gave us this
  fetchedAt: string;             // ISO timestamp
}