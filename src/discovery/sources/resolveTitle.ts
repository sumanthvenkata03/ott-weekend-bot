// src/discovery/sources/resolveTitle.ts
// PURE title→TMDb resolution — the SINGLE shared implementation used by BOTH
// discovery's OTT search (ottSearch.ts) and the reconcile layer (reconcile.ts).
// No I/O: the caller fetches the TmdbTitleSearch (searchTitleTmdb) and passes it
// in, so this stays offline-testable AND keeps reconcile.ts free of network/LLM
// imports (importing it must never open SQLite or spawn the CLI).
//
// The ±1-year filter is the "2019 Blast trap" guard: a 2026 window must not
// resolve a same-title 2019 film. Language-match narrowing then disambiguates
// same-title hits across languages.

import type { TmdbTitleHit, TmdbTitleSearch } from "../../ingestion/releases/tmdb.js";
import type { Language } from "../../shared/types.js";

// The eight Indian languages we cover (TMDb ISO 639-1 codes). A NEW ai-net film
// whose resolved TMDb original_language is not in this set is non-Indian.
export const INDIAN_LANG_CODES = new Set(["te", "ta", "ml", "hi", "kn", "bn", "mr", "pa"]);

const NAME_TO_CODE: Record<string, string> = {
  telugu: "te", tamil: "ta", malayalam: "ml", kannada: "kn",
  hindi: "hi", bengali: "bn", marathi: "mr", punjabi: "pa",
};
const CODE_TO_LANGUAGE: Record<string, Language> = {
  te: "Telugu", ta: "Tamil", ml: "Malayalam", kn: "Kannada",
  hi: "Hindi", mr: "Marathi", bn: "Bengali", pa: "Punjabi",
};

/** Language display-name → TMDb ISO 639-1 code (undefined if unknown). */
export function codeForLanguage(name: string | undefined): string | undefined {
  return name ? NAME_TO_CODE[name.trim().toLowerCase()] : undefined;
}
/** TMDb ISO 639-1 code → Language enum ("Other" if unmapped). */
export function languageForCode(iso: string | undefined): Language {
  return (iso && CODE_TO_LANGUAGE[iso.toLowerCase()]) || "Other";
}

/** Minimal resolver input — structurally satisfied by reconcile's ExtractedFilm. */
export interface ResolveInput {
  title: string;
  language?: string;
  isSeries: boolean;
}

export interface TitleResolution {
  kind: "movie" | "series" | "unverified";
  hit?: TmdbTitleHit;
  ambiguous: boolean;
}

/**
 * Resolve an extracted title against an ALREADY-FETCHED TMDb search:
 *  - isSeries (LLM flag) ⇒ series (belt; the caller skips the search entirely).
 *  - movie hit within ±1yr of the window (then language-narrowed) ⇒ movie.
 *  - else a TV hit ⇒ series; nothing ⇒ unverified.
 */
export function resolveTitleToTmdb(
  input: ResolveInput,
  search: TmdbTitleSearch,
  windowYear: number
): TitleResolution {
  if (input.isSeries) return { kind: "series", ambiguous: false };

  const langCode = codeForLanguage(input.language);
  let movieCands = search.movie.filter(
    (h) => h.year !== undefined && Math.abs(h.year - windowYear) <= 1
  );
  if (langCode) {
    const langMatch = movieCands.filter((h) => h.originalLanguage === langCode);
    if (langMatch.length > 0) movieCands = langMatch;
  }

  if (movieCands.length >= 1) {
    const hit: TmdbTitleHit = movieCands[0]!;
    return { kind: "movie", hit, ambiguous: movieCands.length > 1 };
  }
  if (search.tv.length > 0) return { kind: "series", ambiguous: false };
  return { kind: "unverified", ambiguous: false };
}
