// src/discovery/normalize.ts
// Title normalization used ONLY for dedupe keys. The original title is
// always preserved on the DiscoveredFilm — never overwritten by this.

// Trailing disambiguation parentheticals to drop. Matches one trailing
// group like "(2026)", "(film)", "(2026 film)", "(Telugu)",
// "(Telugu film)", "(TV series)". Applied repeatedly to peel several.
// The language list is an explicit whitelist (NOT a generic [a-z]+ word):
// a catch-all would strip legitimate title suffixes like "(extended)" and
// collapse two distinct films onto one dedupe key — a wrong merge, which is
// worse than a missed merge.
const TRAILING_PAREN =
  /\s*\((?:\d{4}(?:\s+film)?|film|tv series|(?:telugu|tamil|malayalam|kannada|hindi|bengali|marathi|punjabi)(?:\s+film)?)\)\s*$/i;

// Unicode combining marks (U+0300–U+036F) left behind after NFKD.
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Normalize a film title for cross-net matching:
 *  - lowercase
 *  - strip diacritics (NFKD + combining-mark removal)
 *  - canonicalize "&" → "and" (BEFORE punctuation strip, else "&" becomes a
 *    space and "Parimala & Co" / "Parimala and Co" stay distinct)
 *  - drop trailing disambiguation parentheticals (before punctuation strip,
 *    so "Identity (2025 film)" matches TMDb's "Identity")
 *  - strip punctuation → spaces
 *  - collapse whitespace
 */
export function normalizeTitle(s: string): string {
  let out = s.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase();
  // "&" → " and " so the ampersand and the spelled-out word converge.
  out = out.replace(/&/g, " and ");
  // Peel trailing parentheticals one at a time.
  let prev: string;
  do {
    prev = out;
    out = out.replace(TRAILING_PAREN, "");
  } while (out !== prev);
  // Punctuation → space, then collapse runs of whitespace.
  out = out.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  return out;
}
