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

export type Verdict = "🔥 Must Watch" | "👀 Worth a Try" | "⏭️ Skip" | "Pending";

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
  releaseDate: string;           // ISO date YYYY-MM-DD
  theatricalReleaseDate?: string;
  
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
  
  // Ratings (populated by OMDb in later step)
  imdbRating?: number;
  imdbVotes?: number;
  rottenTomatoes?: number;
  
  // Tagging (populated by LLM later)
  mood?: Mood[];
  familyFilter?: FamilyFilter[];
  verdict?: Verdict;
  hypeScore?: number;            // 0-100, populated in Week 2
  
  // Provenance
  sources: string[];             // which APIs/sites gave us this
  fetchedAt: string;             // ISO timestamp
}