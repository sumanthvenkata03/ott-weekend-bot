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
  /** This film's role in the story — becomes the quadrant's gold fact line. */
  note?: string;
  tmdbId?: number;
  posterUrl?: string;
  imdbId?: string;
  /** True when TMDb returned more than one plausible hit — printable, not fatal. */
  ambiguous?: boolean;
}

export interface ResolvedStory {
  story: VerifiedStory;
  /** Lead film — films[0] when present, else the detector hit. Null if none. */
  film: ResolvedFilm | null;
  /** EVERY film the verified page named, resolved. Drives quadrant explosion. */
  films: ResolvedFilm[];
  /** Printable one-liner for the run table. */
  reason: string;
}

// ── SANITY GATE (resolver v2) ───────────────────────────────────────────────
//
// TMDb's search returns SOMETHING for almost any string. Without an identity
// check, "G.D.N" resolved to "Hulk and the Agents of S.M.A.S.H." — the dot-
// separated initials tokenised into a match. A wrong poster is worse than no
// poster: it is a confident, published, visual lie about which film this is.
//
// A hit is accepted only when BOTH hold:
//   • the normalized titles are similar enough to be the same film, AND
//   • the release year is within TMDB_YEAR_TOLERANCE of the window, OR the film
//     independently matches our judged archive (a real identity we already hold).

/** Minimum normalized-title similarity to accept a TMDb hit. */
export const TITLE_SIMILARITY_MIN = 0.6;
/** Years either side of the window a hit may fall and still be plausible. */
export const TMDB_YEAR_TOLERANCE = 3;

/** Comparable title tokens: lowercased, punctuation stripped, no stopwords. */
function titleTokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0 && !["the", "a", "an", "of", "and"].includes(t))
  );
}

/**
 * Title similarity in [0,1]: shared tokens over the SHORTER title, so a short
 * real title is not punished for matching inside a longer one. PURE.
 */
export function titleSimilarity(a: string, b: string): number {
  const A = titleTokenSet(a);
  const B = titleTokenSet(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

export interface SanityVerdict {
  ok: boolean;
  similarity: number;
  /** Printable — why it passed or failed. */
  reason: string;
}

/**
 * Decide whether a TMDb hit is really the film we asked for. PURE, so the
 * Hulk-class rejection is unit-testable without touching the network.
 */
export function sanityCheck(
  asked: string,
  hit: { title: string; year?: number },
  windowYear: number,
  judgedMatch = false
): SanityVerdict {
  const sim = titleSimilarity(asked, hit.title);
  if (sim < TITLE_SIMILARITY_MIN) {
    return {
      ok: false,
      similarity: sim,
      reason: `REJECTED low-sim ${sim.toFixed(2)} (got "${hit.title}")`,
    };
  }
  const yearOk = hit.year === undefined || Math.abs(hit.year - windowYear) <= TMDB_YEAR_TOLERANCE;
  if (!yearOk && !judgedMatch) {
    return {
      ok: false,
      similarity: sim,
      reason: `REJECTED year ${hit.year} outside ±${TMDB_YEAR_TOLERANCE} of ${windowYear} (got "${hit.title}")`,
    };
  }
  return { ok: true, similarity: sim, reason: `sim ${sim.toFixed(2)}${judgedMatch ? " +judged" : ""}` };
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
/**
 * Resolve ONE title against TMDb, gated. Returns null when the gate rejects —
 * a rejection is a success of the guard, not a failure of the run.
 */
async function resolveOne(
  title: string,
  language: string,
  windowYear: number,
  confidence: ResolveConfidence,
  judgedMatch = false
): Promise<{ film: ResolvedFilm | null; reason: string }> {
  try {
    const search = await searchTitleTmdb(title, { year: windowYear, language });
    const res = resolveTitleToTmdb({ title, language, isSeries: false }, search, windowYear);
    if (res.kind !== "movie" || !res.hit) {
      return { film: null, reason: `"${title}" → no TMDb movie match` };
    }
    const sane = sanityCheck(title, res.hit, windowYear, judgedMatch);
    if (!sane.ok) return { film: null, reason: `"${title}" → ${sane.reason}` };

    const poster = posterUrl(res.hit.posterPath ?? null);
    return {
      film: {
        title: res.hit.title,
        confidence,
        tmdbId: res.hit.id,
        ...(poster ? { posterUrl: poster } : {}),
        ...(res.ambiguous ? { ambiguous: true } : {}),
      },
      reason:
        `"${title}" → tmdb ${res.hit.id}${poster ? " +poster" : " (no poster art)"}` +
        ` [${sane.reason}]${res.ambiguous ? " ambiguous" : ""}`,
    };
  } catch (err) {
    return { film: null, reason: `"${title}" → lookup failed (${err instanceof Error ? err.message : String(err)})` };
  }
}

/**
 * Resolve one confirmed story to its film set, best effort. Never throws.
 *
 * PREFERRED PATH (v2): the verifier's `films[]` — titles read off the page it
 * actually retrieved, so an awards story yields every winner, not just whatever
 * the headline happened to lead with. Each entry goes through the sanity gate
 * independently; rejects are logged and dropped.
 *
 * FALLBACK: the original headline detectors, unchanged, for stories the verifier
 * gave no film list (person-only stories, or an older cached verdict).
 */
export async function resolveStory(
  story: VerifiedStory,
  judged: JudgedFilm[],
  findJudged: (title: string, films: JudgedFilm[]) => JudgedFilm | null,
  windowYear: number
): Promise<ResolvedStory> {
  const headline = story.cluster.headline;
  const language = story.cluster.language;
  const reasons: string[] = [];

  // ── v2: resolve every film the page named ──
  if (story.films.length > 0) {
    const films: ResolvedFilm[] = [];
    for (const ref of story.films) {
      const judgedHit = findJudged(ref.title, judged);
      const { film, reason } = await resolveOne(
        ref.title, language, windowYear, "quoted", Boolean(judgedHit)
      );
      reasons.push(reason);
      if (film) {
        films.push({ ...film, note: ref.note, ...(judgedHit?.imdbId ? { imdbId: judgedHit.imdbId } : {}) });
      } else if (judgedHit) {
        // No TMDb art, but a real identity we already hold — keep it typographic.
        films.push({ title: ref.title, confidence: "judged", note: ref.note, ...(judgedHit.imdbId ? { imdbId: judgedHit.imdbId } : {}) });
      } else {
        // Named by the page but unresolvable → still a real film, rendered
        // typographically. The page is the provenance; TMDb is only the art.
        films.push({ title: ref.title, confidence: "none", note: ref.note });
      }
    }
    return {
      story,
      film: films[0] ?? null,
      films,
      reason: reasons.join(" · "),
    };
  }

  // ── fallback: headline detectors ──
  const extracted = extractFilmTitle(headline);
  if (extracted) {
    const { film, reason } = await resolveOne(
      extracted.title, language, windowYear, extracted.confidence
    );
    if (film) return { story, film, films: [film], reason: `${extracted.confidence}:${reason}` };
    reasons.push(`${extracted.confidence}:${reason}`);
  }

  const judgedHit = findJudged(headline, judged);
  if (judgedHit) {
    const film: ResolvedFilm = {
      title: judgedHit.title,
      confidence: "judged",
      ...(judgedHit.imdbId ? { imdbId: judgedHit.imdbId } : {}),
    };
    return { story, film, films: [film], reason: `judged:"${judgedHit.title}" (no poster — judged index carries no art)` };
  }

  return {
    story,
    film: null,
    films: [],
    reason: reasons.length ? reasons.join(" · ") : "no title detected — typographic",
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
