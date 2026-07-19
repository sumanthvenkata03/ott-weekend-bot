// src/content/news/news-resolve.ts
// NEWS DESK · POST-VERIFY film-entity resolution (ruling R1).
//
// A gathered NewsItem is {headline, outlet, date, language} — there is no film
// in it. The published design system is poster-led, so before anything can be
// rendered we have to answer: WHICH FILM is this story about, and do we have art?
//
// This runs AFTER verification, on confirmed stories only. Gather is untouched,
// and we never spend a TMDb call on a story that failed its receipt check.
//
// Three detectors, in confidence order — the FIRST hit wins:
//   (a) quoted    — 'Lenin' / "Lenin" / ‘Lenin’ in the headline. Outlets quote
//                   film titles precisely; this is the strongest signal.
//   (b) prefix    — the span before a colon or a strong verb ("Balan The Boy
//                   Locks Pan-Indian OTT Release Date" → "Balan The Boy").
//                   Indian trade headlines lead with the film far more often
//                   than not.
//   (c) judged    — the existing judged-film index (findJudgedMention). Weakest
//                   for ART (JudgedFilm carries an optional imdbId, no poster),
//                   but it is a REAL identity and earns the ★ chip.
//
// Anything unresolved stays unresolved and renders typographic (§2.2's maroon
// quadrant). That is a designed fallback, not a failure — see the format rules.
//
// OUT OF SCOPE FOR v1 (ruling R1): event-cluster winner-film resolution. An
// awards story names many films ("Raayan wins Best Tamil Film"); pulling the
// winner set out of a headline is its own extraction problem. Those items render
// typographic unless a judged match happens to fire.

import { searchTitleTmdb, posterUrl } from "../../ingestion/releases/tmdb.js";
import { resolveTitleToTmdb } from "../../discovery/sources/resolveTitle.js";
import { log } from "../../shared/logger.js";
import type { VerifiedStory } from "./news-verify.js";
import type { JudgedFilm } from "../../jobs/reddit-radar.js";

export type ResolveConfidence = "quoted" | "prefix" | "judged" | "none";

export interface ResolvedFilm {
  /** Title as extracted (detector (a)/(b)) or as judged (detector (c)). */
  title: string;
  confidence: ResolveConfidence;
  tmdbId?: number;
  posterUrl?: string;
  imdbId?: string;
  /** True when TMDb returned more than one plausible hit — printable, not fatal. */
  ambiguous?: boolean;
}

export interface ResolvedStory {
  story: VerifiedStory;
  film: ResolvedFilm | null;
  /** Printable one-liner for the run table. */
  reason: string;
}

// ── Detectors (PURE — no I/O, unit-tested off real headlines) ────────────────

/** Straight, curly and double quotes; 2–60 chars; not an all-caps SHOUT run. */
const QUOTED_RE = /['‘"“]([^'’"”]{2,60})['’"”]/;

/**
 * Leading title span before a colon or a strong announcement verb. Anchored at
 * the string start so a mid-headline colon ("Report: Foo") can't win.
 */
const PREFIX_VERBS =
  /^(.{2,60}?)\s+(?:locks?|gets?|sets?|confirms?|announces?|heads?|lands?|to release|release date|on ott|ott release|box office|wins?|bags?)\b/i;
const PREFIX_COLON = /^([^:]{2,60}):\s/;

/** Words that are never a film title on their own — kills prefix false hits. */
const NOT_A_TITLE = new Set([
  "report", "exclusive", "breaking", "watch", "review", "opinion", "analysis",
  "confirmed", "update", "just in", "big news", "shocking", "revealed",
]);

function cleanTitle(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, " ").replace(/[.,;–—-]+$/, "");
  if (t.length < 2 || t.length > 60) return null;
  if (NOT_A_TITLE.has(t.toLowerCase())) return null;
  // A span of 8+ words is a sentence, not a title.
  if (t.split(" ").length > 8) return null;
  return t;
}

/** (a) quoted title. */
export function extractQuotedTitle(headline: string): string | null {
  const m = headline.match(QUOTED_RE);
  return m?.[1] ? cleanTitle(m[1]) : null;
}

/** (b) colon/verb-prefixed title span. */
export function extractPrefixTitle(headline: string): string | null {
  const colon = headline.match(PREFIX_COLON);
  if (colon?.[1]) {
    const t = cleanTitle(colon[1]);
    if (t) return t;
  }
  const verb = headline.match(PREFIX_VERBS);
  if (verb?.[1]) {
    const t = cleanTitle(verb[1]);
    if (t) return t;
  }
  return null;
}

/** The extracted candidate + which detector found it. PURE. */
export function extractFilmTitle(
  headline: string
): { title: string; confidence: "quoted" | "prefix" } | null {
  const quoted = extractQuotedTitle(headline);
  if (quoted) return { title: quoted, confidence: "quoted" };
  const prefix = extractPrefixTitle(headline);
  if (prefix) return { title: prefix, confidence: "prefix" };
  return null;
}

// ── Resolution (does I/O: cached TMDb search) ────────────────────────────────

/**
 * Resolve one confirmed story to a film + poster, best effort. Never throws:
 * a TMDb failure degrades to unresolved, and unresolved renders typographic.
 */
export async function resolveStory(
  story: VerifiedStory,
  judged: JudgedFilm[],
  findJudged: (title: string, films: JudgedFilm[]) => JudgedFilm | null,
  windowYear: number
): Promise<ResolvedStory> {
  const headline = story.cluster.headline;

  const extracted = extractFilmTitle(headline);
  if (extracted) {
    try {
      const search = await searchTitleTmdb(extracted.title, {
        year: windowYear,
        language: story.cluster.language,
      });
      const res = resolveTitleToTmdb(
        { title: extracted.title, language: story.cluster.language, isSeries: false },
        search,
        windowYear
      );
      if (res.kind === "movie" && res.hit) {
        const poster = posterUrl(res.hit.posterPath ?? null);
        return {
          story,
          film: {
            title: res.hit.title,
            confidence: extracted.confidence,
            tmdbId: res.hit.id,
            ...(poster ? { posterUrl: poster } : {}),
            ...(res.ambiguous ? { ambiguous: true } : {}),
          },
          reason:
            `${extracted.confidence}:"${extracted.title}" → TMDb ${res.hit.id}` +
            `${poster ? " +poster" : " (no poster art)"}${res.ambiguous ? " [ambiguous]" : ""}`,
        };
      }
    } catch (err) {
      log.warn(`  resolve failed for "${extracted.title}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // (c) judged index — a real identity even without art.
  const judgedHit = findJudged(headline, judged);
  if (judgedHit) {
    return {
      story,
      film: {
        title: judgedHit.title,
        confidence: "judged",
        ...(judgedHit.imdbId ? { imdbId: judgedHit.imdbId } : {}),
      },
      reason: `judged:"${judgedHit.title}" (no poster — judged index carries no art)`,
    };
  }

  return {
    story,
    film: null,
    reason: extracted
      ? `${extracted.confidence}:"${extracted.title}" → no TMDb match — typographic`
      : "no title detected — typographic",
  };
}

/** Resolve every confirmed story. Sequential: the TMDb client is throttled anyway. */
export async function resolveStories(
  stories: VerifiedStory[],
  judged: JudgedFilm[],
  findJudged: (title: string, films: JudgedFilm[]) => JudgedFilm | null,
  windowYear: number
): Promise<ResolvedStory[]> {
  const out: ResolvedStory[] = [];
  for (const s of stories) out.push(await resolveStory(s, judged, findJudged, windowYear));
  return out;
}

/** A story that can carry the poster-led JN skin. */
export function hasPoster(r: ResolvedStory): boolean {
  return Boolean(r.film?.posterUrl);
}
