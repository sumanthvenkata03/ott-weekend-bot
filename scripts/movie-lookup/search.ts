// scripts/movie-lookup/search.ts
// Google-style fuzzy search for the internal movie-lookup tool.
//
// Type any words in any order. Language / year words are recognised as SOFT
// signals (they BOOST matching results, they never hard-exclude). The remaining
// words are the title query. Movies AND series are returned, labelled, ranked
// best-first.
//
// Uses the tool-local UNCACHED tmdbGet (sources.ts) against TMDb /search/multi,
// so search writes NOTHING to data/cache.sqlite. Order-independence is guaranteed:
// title tokens are SORTED before building the API query and ranking is set-based,
// so "telugu boss" and "boss telugu" issue identical calls and rank identically.

import { tmdbGet, langName, img } from "./sources.js";

export const DEFAULT_SEARCH_LIMIT = 30;

// Recall depth (pages of 20). A plain title only needs the popular top pages; a
// language/year signal pages deeper so a low-popularity language match can be
// pulled into range for the SOFT boost (TMDb /search has no content-language
// filter). Overridable via env for tuning.
const PLAIN_PAGES = Number.parseInt(process.env.MOVIE_LOOKUP_PLAIN_PAGES ?? "2", 10) || 2;
const SIGNAL_DEEP_PAGES = Number.parseInt(process.env.MOVIE_LOOKUP_DEEP_PAGES ?? "10", 10) || 10;

// Language word -> TMDb ISO 639-1 code. Soft filter vocabulary.
const LANGUAGE_TO_ISO: Record<string, string> = {
  telugu: "te", tamil: "ta", hindi: "hi", malayalam: "ml", kannada: "kn",
  bengali: "bn", marathi: "mr", punjabi: "pa", english: "en",
  gujarati: "gu", odia: "or", assamese: "as", urdu: "ur",
};

export interface ParsedQuery {
  raw: string;
  titleTokens: string[];   // original order — used for exact/startsWith checks
  queryString: string;     // sorted title tokens — used to build API queries
  langCodes: string[];     // recognised language signals (ISO codes)
  year?: number;           // recognised 4-digit year signal
}

function stripToken(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseQuery(raw: string): ParsedQuery {
  const rawTokens = raw.split(/\s+/).map(stripToken).filter(Boolean);
  const titleTokens: string[] = [];
  const langCodes: string[] = [];
  let year: number | undefined;

  for (const t of rawTokens) {
    if (LANGUAGE_TO_ISO[t]) { langCodes.push(LANGUAGE_TO_ISO[t]!); continue; }
    if (/^\d{4}$/.test(t)) {
      const y = Number.parseInt(t, 10);
      if (y >= 1900 && y <= 2100) { year = y; continue; }
    }
    titleTokens.push(t);
  }

  // Query is ONLY language/year words (e.g. "telugu", "2024") — fall back to
  // searching those words as the title so the box still returns something.
  const effectiveTitle = titleTokens.length > 0 ? titleTokens : rawTokens;
  const queryString = [...effectiveTitle].sort().join(" ");

  return { raw, titleTokens: effectiveTitle, queryString, langCodes, year };
}

// ── TMDb /search/multi shapes ────────────────────────────────────────────────
export interface MultiHit {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  original_language?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  popularity?: number;
  vote_count?: number;
  vote_average?: number;
}
interface MultiResponse { results?: MultiHit[]; total_results?: number; total_pages?: number; page?: number; }

export interface RankedResult {
  id: number;
  mediaType: "movie" | "tv";
  title: string;
  originalTitle?: string;
  year?: number;
  language?: string;
  languageIso?: string;
  thumb?: string;
  popularity?: number;
  voteCount?: number;
  voteAverage?: number;
  score: number;
}

function yearOf(d: string | null | undefined): number | undefined {
  if (!d) return undefined;
  const y = Number.parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
}

async function multiSearchPage(query: string, page: number): Promise<MultiResponse> {
  try {
    return await tmdbGet<MultiResponse>("/search/multi", { query, include_adult: "false", page: String(page) });
  } catch {
    return {};
  }
}

/** Fetch up to `maxPages` of /search/multi for one query (page 1 always; deeper
 *  pages only if they exist). Deeper recall is what lets a SOFT language/year
 *  boost lift a lower-popularity match (e.g. a Telugu "Boss") that page 1 —
 *  ordered by global popularity — would never surface. */
async function multiSearchDeep(query: string, maxPages: number): Promise<MultiHit[]> {
  if (!query.trim()) return [];
  const first = await multiSearchPage(query, 1);
  const out = [...(first.results ?? [])];
  const pages = Math.min(maxPages, first.total_pages ?? 1);
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => multiSearchPage(query, i + 2))
    );
    for (const r of rest) out.push(...(r.results ?? []));
  }
  return out;
}

/** Broaden recall: the sorted combined query (deep), PLUS per-token queries when
 *  there are ≥2 title tokens (catches out-of-order / partial multi-word titles).
 *  Deeper when a language/year signal is present so the boost has candidates to
 *  act on. All merged + deduped by mediaType:id. */
async function gatherCandidates(pq: ParsedQuery): Promise<MultiHit[]> {
  const hasSignal = pq.langCodes.length > 0 || pq.year !== undefined;
  // With NO content-language filter on TMDb /search, a language/year match can
  // sit deep (a low-popularity Telugu "Boss" is on page 10). So when the user
  // gives a language/year signal we page deep enough to pull it into range for
  // the boost; a plain title needs only the popular top pages.
  const combinedPages = hasSignal ? SIGNAL_DEEP_PAGES : PLAIN_PAGES;

  const jobs: Promise<MultiHit[]>[] = [multiSearchDeep(pq.queryString, combinedPages)];
  if (pq.titleTokens.length >= 2) {
    const seen = new Set([pq.queryString]);
    for (const t of pq.titleTokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      jobs.push(multiSearchDeep(t, hasSignal ? 3 : 1));
    }
  }

  const batches = await Promise.all(jobs);
  const byKey = new Map<string, MultiHit>();
  for (const batch of batches) {
    for (const h of batch) {
      const mt = h.media_type;
      if (mt !== "movie" && mt !== "tv") continue; // drop people etc.
      const key = `${mt}:${h.id}`;
      if (!byKey.has(key)) byKey.set(key, h);
    }
  }
  return [...byKey.values()];
}

const normalize = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Fraction of title tokens present in the title — whole-word match counts full,
 *  substring counts partial. Averaged across tokens. Order-independent. */
function tokenPresence(titleTokens: string[], normTitle: string): number {
  if (titleTokens.length === 0) return 0;
  let sum = 0;
  for (const tok of titleTokens) {
    if (new RegExp(`\\b${tok}\\b`).test(normTitle)) sum += 1;
    else if (normTitle.includes(tok)) sum += 0.6;
  }
  return sum / titleTokens.length;
}

function scoreHit(pq: ParsedQuery, hit: MultiHit): RankedResult {
  const mediaType = (hit.media_type === "tv" ? "tv" : "movie") as "movie" | "tv";
  const title = hit.title ?? hit.name ?? "(untitled)";
  const original = hit.original_title ?? hit.original_name;
  const year = yearOf(hit.release_date ?? hit.first_air_date);
  const iso = hit.original_language;

  const normTitle = normalize(title);
  const normOrig = original ? normalize(original) : "";

  // Title relevance — fully ORDER-INDEPENDENT (set-based) so any typed word order
  // scores identically. Best of localized + original title.
  const present = Math.max(tokenPresence(pq.titleTokens, normTitle), tokenPresence(pq.titleTokens, normOrig));
  let score = present * 50;

  // Exact bonus = same word SET, any order (sorted-token equality).
  const qset = [...pq.titleTokens].sort().join(" ");
  const tset = normTitle.split(" ").filter(Boolean).sort().join(" ");
  const oset = normOrig ? normOrig.split(" ").filter(Boolean).sort().join(" ") : "";
  if (qset.length > 0 && (qset === tset || qset === oset)) score += 60;

  // SOFT language boost — a strong signal (the user explicitly typed a language),
  // but it only BOOSTS; a non-matching / unknown-language result is never excluded.
  if (pq.langCodes.length && iso && pq.langCodes.includes(iso)) score += 30;
  // SOFT year boost.
  if (pq.year !== undefined && year !== undefined) {
    const diff = Math.abs(year - pq.year);
    if (diff === 0) score += 25;
    else if (diff <= 1) score += 12;
  }

  // Tie-breakers (bounded so they never outweigh title relevance).
  score += Math.min(Math.log10(1 + (hit.popularity ?? 0)) * 3, 9);
  score += Math.min(Math.log10(1 + (hit.vote_count ?? 0)) * 1.5, 6);

  return {
    id: hit.id,
    mediaType,
    title,
    ...(original && original !== title ? { originalTitle: original } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(iso ? { language: langName(iso), languageIso: iso } : {}),
    ...(hit.poster_path ? { thumb: img(hit.poster_path, "w185") } : {}),
    ...(hit.popularity !== undefined ? { popularity: hit.popularity } : {}),
    ...(hit.vote_count !== undefined ? { voteCount: hit.vote_count } : {}),
    ...(hit.vote_average !== undefined ? { voteAverage: hit.vote_average } : {}),
    score: Math.round(score * 10) / 10,
  };
}

export interface RankedSearch {
  query: string;
  parsed: { titleTokens: string[]; languages: string[]; year?: number };
  count: number;
  candidates: RankedResult[];
}

/** PURE ranking (no network) — dedupe by mediaType:id, score, sort, cap. Exported
 *  so the tool's tests can prove order-independence / soft boosts offline. */
export function rankHits(pq: ParsedQuery, hits: MultiHit[], limit = DEFAULT_SEARCH_LIMIT): RankedResult[] {
  const byKey = new Map<string, MultiHit>();
  for (const h of hits) {
    const mt = h.media_type === "tv" ? "tv" : "movie";
    const key = `${mt}:${h.id}`;
    if (!byKey.has(key)) byKey.set(key, h);
  }
  return [...byKey.values()]
    .map((h) => scoreHit(pq, h))
    .sort((a, b) =>
      b.score - a.score ||
      (b.voteCount ?? 0) - (a.voteCount ?? 0) ||
      a.title.localeCompare(b.title) ||
      a.id - b.id // fully deterministic: identical candidate sets rank identically regardless of typed word order
    )
    .slice(0, limit);
}

/** Full Google-style ranked search (fetch + rank). */
export async function rankedSearch(raw: string, limit = DEFAULT_SEARCH_LIMIT): Promise<RankedSearch> {
  const pq = parseQuery(raw);
  const hits = await gatherCandidates(pq);
  const ranked = rankHits(pq, hits, limit);
  return {
    query: raw,
    parsed: {
      titleTokens: pq.titleTokens,
      languages: pq.langCodes.map((c) => langName(c) ?? c),
      ...(pq.year !== undefined ? { year: pq.year } : {}),
    },
    count: ranked.length,
    candidates: ranked,
  };
}
