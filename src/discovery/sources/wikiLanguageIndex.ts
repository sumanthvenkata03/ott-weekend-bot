// src/discovery/sources/wikiLanguageIndex.ts
// WD-ENG-06 — A SECOND OPINION ON "WHAT LANGUAGE IS THIS FILM".
//
// The ai-net's language guard trusts exactly one field: TMDb's
// `original_language`. For an established film that is fine. For a film TMDb
// only just learned about, `original_language` is a provisional stub — Agadha
// (tmdb 1747034, releasing 2026-08-14) carries `"en"` while the SAME record says
// `origin_country: ["IN"]`, and while it sits in the List of Telugu films of
// 2026 under 14 August.
//
// A title's presence in "List of <Language> films of <year>" is a real language
// signal, editorially maintained, and already on disk: the Wikipedia net fetches
// those pages every run and they live in the http_cache for 30 days. This module
// turns them into a normalizedTitle → Language lookup.
//
// PURE. It takes already-fetched HTML and returns a Map. No fetch, no cache, no
// clock — so it is driven in tests by the frozen 2026 list fixtures, and in
// production by pages the discovery run has already paid for.

import { parsePage } from "./wikipediaList.js";
import { normalizeTitle } from "../normalize.js";

/** One already-fetched list page. */
export interface WikiListPage {
  /** The pillar language the page enumerates ("Telugu", "Kannada", …). */
  language: string;
  year: number;
  /** Rendered page HTML (parse.text), exactly as fetchListHtml returns it. */
  html: string;
}

/**
 * normalizedTitle → language, built from whole-year parses of the given pages.
 *
 * WHOLE YEAR, deliberately: the question this index answers is "what language is
 * this film", which has nothing to do with the query window. Narrowing it to the
 * window would make the signal disappear for exactly the films whose dates are
 * still moving — the provisional records that need it most.
 *
 * A title listed under two languages (a genuine bilingual, or a namesake) maps
 * to the FIRST page that named it, and `wikiLanguageConflicts` reports the rest.
 * Callers use this to say "Indian", never to overwrite a resolved language.
 */
export function buildWikiLanguageIndex(pages: readonly WikiListPage[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const p of pages) {
    if (!p.html) continue;
    const { films } = parsePage(p.html, p.language, p.year, "", `${p.year}-01-01`, `${p.year}-12-31`);
    for (const f of films) {
      const key = f.normalizedTitle || normalizeTitle(f.title);
      if (!key) continue;
      if (!index.has(key)) index.set(key, p.language);
    }
  }
  return index;
}

/**
 * The language a Wikipedia list attributes to `title`, or undefined when no list
 * names it. Matching is on the SAME normalizeTitle the discovery union uses, so
 * a film cannot be found here under a spelling the rest of the pipeline would
 * treat as a different film.
 */
export function wikiLanguageFor(
  index: ReadonlyMap<string, string> | undefined,
  title: string
): string | undefined {
  if (!index || index.size === 0) return undefined;
  const key = normalizeTitle(title);
  return key ? index.get(key) : undefined;
}
