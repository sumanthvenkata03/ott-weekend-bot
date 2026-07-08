// scripts/movie-lookup/search.ts
// Cinema-wide, intelligent, Google-style search for the movie-lookup tool.
//
// Typing a name returns PEOPLE (actors/directors/composers/producers/writers),
// MOVIES, SERIES, and PRODUCTION COMPANIES in one ranked list. Default priority is
// PEOPLE > MOVIES > SERIES > COMPANIES (a person outranks a same-name movie).
// Soft TYPE/ROLE keywords ("actor Sneha", "director Rajamouli", "Sneha movie")
// steer the ranking without ever hard-excluding other types. Tokens are
// order-independent; language/year remain soft signals.
//
// Sources (all via the existing TMDB_API_KEY, uncached): /search/multi (person +
// movie + tv), /search/person (recall for low-popularity people), /search/company.

import { tmdbGet, langName, img } from "./sources.js";

export const DEFAULT_SEARCH_LIMIT = 30;

const PLAIN_PAGES = Number.parseInt(process.env.MOVIE_LOOKUP_PLAIN_PAGES ?? "2", 10) || 2;
const SIGNAL_DEEP_PAGES = Number.parseInt(process.env.MOVIE_LOOKUP_DEEP_PAGES ?? "10", 10) || 10;

export type ResultType = "person" | "movie" | "series" | "company";

// Language word -> TMDb ISO 639-1 code. Soft filter vocabulary.
const LANGUAGE_TO_ISO: Record<string, string> = {
  telugu: "te", tamil: "ta", hindi: "hi", malayalam: "ml", kannada: "kn",
  bengali: "bn", marathi: "mr", punjabi: "pa", english: "en",
  gujarati: "gu", odia: "or", assamese: "as", urdu: "ur",
};

// Soft TYPE / ROLE keywords → boost a result type and (for people) a department.
interface TypeKeyword { type?: ResultType; dept?: string; }
const TYPE_KEYWORDS: Record<string, TypeKeyword> = {
  movie: { type: "movie" }, film: { type: "movie" }, films: { type: "movie" }, movies: { type: "movie" },
  actor: { type: "person", dept: "Acting" }, actress: { type: "person", dept: "Acting" },
  cast: { type: "person", dept: "Acting" }, hero: { type: "person", dept: "Acting" },
  heroine: { type: "person", dept: "Acting" }, star: { type: "person", dept: "Acting" },
  person: { type: "person" }, people: { type: "person" },
  director: { type: "person", dept: "Directing" }, directors: { type: "person", dept: "Directing" },
  composer: { type: "person", dept: "Sound" }, musician: { type: "person", dept: "Sound" }, music: { type: "person", dept: "Sound" },
  producer: { type: "person", dept: "Production" }, producers: { type: "person", dept: "Production" },
  writer: { type: "person", dept: "Writing" }, writers: { type: "person", dept: "Writing" },
  series: { type: "series" }, show: { type: "series" }, shows: { type: "series" }, tv: { type: "series" }, serial: { type: "series" },
  studio: { type: "company" }, studios: { type: "company" }, company: { type: "company" }, companies: { type: "company" },
  productions: { type: "company" }, production: { type: "company" }, house: { type: "company" }, banner: { type: "company" },
};
// Department precedence when several role words appear (e.g. "music director" ⇒ Sound).
const DEPT_PRECEDENCE = ["Sound", "Directing", "Production", "Writing", "Acting"];

export interface ParsedQuery {
  raw: string;
  titleTokens: string[];      // the name/title query (keywords/lang/year stripped)
  queryString: string;        // sorted title tokens — used to build API queries
  langCodes: string[];
  year?: number;
  typeBoosts: ResultType[];   // soft type boosts from keywords
  roleDept?: string;          // soft role/department boost for people
}

function stripToken(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseQuery(raw: string): ParsedQuery {
  const rawTokens = raw.split(/\s+/).map(stripToken).filter(Boolean);
  const titleTokens: string[] = [];
  const langCodes: string[] = [];
  const typeBoostSet = new Set<ResultType>();
  const depts = new Set<string>();
  let year: number | undefined;

  for (const t of rawTokens) {
    if (LANGUAGE_TO_ISO[t]) { langCodes.push(LANGUAGE_TO_ISO[t]!); continue; }
    if (/^\d{4}$/.test(t)) {
      const y = Number.parseInt(t, 10);
      if (y >= 1900 && y <= 2100) { year = y; continue; }
    }
    const kw = TYPE_KEYWORDS[t];
    if (kw) { if (kw.type) typeBoostSet.add(kw.type); if (kw.dept) depts.add(kw.dept); continue; }
    titleTokens.push(t);
  }

  // If EVERYTHING was a keyword/lang/year, fall back to searching the raw words.
  const effectiveTitle = titleTokens.length > 0 ? titleTokens : rawTokens;
  const roleDept = DEPT_PRECEDENCE.find((d) => depts.has(d));

  return {
    raw,
    titleTokens: effectiveTitle,
    queryString: [...effectiveTitle].sort().join(" "),
    langCodes,
    ...(year !== undefined ? { year } : {}),
    typeBoosts: [...typeBoostSet],
    ...(roleDept ? { roleDept } : {}),
  };
}

// ── TMDb response shapes ─────────────────────────────────────────────────────
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
  profile_path?: string | null;
  known_for_department?: string;
  known_for?: { title?: string; name?: string; media_type?: string }[];
  popularity?: number;
  vote_count?: number;
  vote_average?: number;
}
export interface CompanyHit { id: number; name: string; logo_path?: string | null; origin_country?: string; }
interface MultiResponse { results?: MultiHit[]; total_pages?: number; }
interface CompanyResponse { results?: CompanyHit[]; }

export interface RankedResult {
  type: ResultType;
  id: number;
  mediaType?: "movie" | "tv";     // back-compat for movie/series
  title: string;
  originalTitle?: string;
  year?: number;
  language?: string;
  languageIso?: string;
  knownForDepartment?: string;
  knownForTitle?: string;
  originCountry?: string;
  thumb?: string;
  popularity?: number;
  voteCount?: number;
  voteAverage?: number;
  clickable: boolean;
  score: number;
}

function yearOf(d: string | null | undefined): number | undefined {
  if (!d) return undefined;
  const y = Number.parseInt(d.slice(0, 4), 10);
  return Number.isFinite(y) ? y : undefined;
}
const normalize = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Fraction of query tokens present in the name — whole-word full, substring partial. */
function tokenPresence(tokens: string[], norm: string): number {
  if (tokens.length === 0) return 0;
  let sum = 0;
  for (const tok of tokens) {
    if (new RegExp(`\\b${tok}\\b`).test(norm)) sum += 1;
    else if (norm.includes(tok)) sum += 0.6;
  }
  return sum / tokens.length;
}

// Type base — encodes the DEFAULT priority people > movies > series > companies,
// but only as a NEAR-TIE-BREAKER: it must NOT let a one-token partial match of a
// high-priority type bury a full-name match of a lower-priority type (e.g. a
// person matching only "raj" must not outrank the company "Yash Raj Films"). Name
// relevance dominates; explicit TYPE keywords (TYPE_BOOST) do the strong steering.
// The person>movie guarantee applies to NOTABLE people: a notable same-name person
// (person−movie gap 18 exceeds the ~15 max popularity/vote swing) stays above a
// same-name movie even when the movie is far more popular. An OBSCURE namesake (no
// image AND ~zero popularity) instead uses TYPE_BASE_PERSON_OBSCURE (below movie),
// so an image-less, ~zero-popularity person no longer buries a real same-name film.
// The gaps to company (22) stay below the partial-vs-full name-relevance gap (25)
// so a full-name company isn't buried by one-token partial people.
const TYPE_BASE: Record<ResultType, number> = { person: 22, movie: 4, series: 2, company: 0 };
// Notability gate for people. Notable = has a profile image OR popularity ≥ the
// threshold. A notable person keeps TYPE_BASE.person; an obscure namesake (no image
// AND ~zero popularity) drops to a base of 0 — BELOW movie(4). Since an obscure
// person's popularity contribution is at most ~1.8 (pop < 3 ⇒ log10(1+pop)*3), a base
// of 0 guarantees ANY same-name film (base 4) — even a brand-new, low-popularity one
// like the 2026 "Lenin" — surfaces above it. Both tunable.
const PERSON_NOTABLE_MIN_POP = 3;
const TYPE_BASE_PERSON_OBSCURE = 0;
const TYPE_RANK: Record<ResultType, number> = { person: 0, movie: 1, series: 2, company: 3 };
// An EXPLICIT type keyword ("movie", "actor", "company") strongly steers that type
// to the top — big enough that a reasonably name-matching item of the requested
// type beats a same-name item of the default-priority type, but not so big that a
// non-matching item (name relevance 0) floats up.
const TYPE_BOOST = 100;

/** Name relevance (present + same-word-set exact bonus), order-independent. */
function nameRelevance(pq: ParsedQuery, primary: string, secondary?: string): number {
  const nA = normalize(primary);
  const nB = secondary ? normalize(secondary) : "";
  const present = Math.max(tokenPresence(pq.titleTokens, nA), tokenPresence(pq.titleTokens, nB));
  let s = present * 50;
  const qset = [...pq.titleTokens].sort().join(" ");
  const aset = nA.split(" ").filter(Boolean).sort().join(" ");
  const bset = nB ? nB.split(" ").filter(Boolean).sort().join(" ") : "";
  if (qset.length > 0 && (qset === aset || qset === bset)) s += 60;
  return s;
}

function scoreMulti(pq: ParsedQuery, hit: MultiHit): RankedResult {
  const type: ResultType = hit.media_type === "person" ? "person" : hit.media_type === "tv" ? "series" : "movie";
  const title = hit.title ?? hit.name ?? "(untitled)";
  const original = hit.original_title ?? hit.original_name;
  const year = yearOf(hit.release_date ?? hit.first_air_date);
  const iso = hit.original_language;

  let score = nameRelevance(pq, title, original);
  if (type === "person") {
    // Notable people keep the full people-first base; an image-less, ~zero-popularity
    // namesake drops below movie so a real same-name film isn't buried by it.
    const notable = !!hit.profile_path || (hit.popularity ?? 0) >= PERSON_NOTABLE_MIN_POP;
    score += notable ? TYPE_BASE.person : TYPE_BASE_PERSON_OBSCURE;
  } else {
    score += TYPE_BASE[type];
  }
  if (pq.typeBoosts.includes(type)) score += TYPE_BOOST;                           // soft TYPE keyword boost (steers regardless of notability)

  const knownForTitle = (hit.known_for ?? []).map((k) => k.title ?? k.name).find(Boolean);
  if (type === "person") {
    // soft ROLE keyword boost (director → Directing, composer → Sound, …)
    if (pq.roleDept && hit.known_for_department === pq.roleDept) score += 35;
  } else {
    if (pq.langCodes.length && iso && pq.langCodes.includes(iso)) score += 30;     // soft language
    if (pq.year !== undefined && year !== undefined) {                             // soft year
      const diff = Math.abs(year - pq.year);
      if (diff === 0) score += 25; else if (diff <= 1) score += 12;
    }
  }
  score += Math.min(Math.log10(1 + (hit.popularity ?? 0)) * 3, 9);
  score += Math.min(Math.log10(1 + (hit.vote_count ?? 0)) * 1.5, 6);

  const thumb = type === "person" ? img(hit.profile_path ?? null, "w185") : img(hit.poster_path ?? null, "w185");
  return {
    type,
    id: hit.id,
    ...(type !== "person" ? { mediaType: (hit.media_type === "tv" ? "tv" : "movie") as "movie" | "tv" } : {}),
    title,
    ...(original && original !== title ? { originalTitle: original } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(iso ? { language: langName(iso), languageIso: iso } : {}),
    ...(hit.known_for_department ? { knownForDepartment: hit.known_for_department } : {}),
    ...(knownForTitle ? { knownForTitle } : {}),
    ...(thumb ? { thumb } : {}),
    ...(hit.popularity !== undefined ? { popularity: hit.popularity } : {}),
    ...(hit.vote_count !== undefined ? { voteCount: hit.vote_count } : {}),
    ...(hit.vote_average !== undefined ? { voteAverage: hit.vote_average } : {}),
    clickable: type === "person" || type === "movie",
    score: Math.round(score * 10) / 10,
  };
}

function scoreCompany(pq: ParsedQuery, c: CompanyHit): RankedResult {
  let score = nameRelevance(pq, c.name);
  score += TYPE_BASE.company;
  if (pq.typeBoosts.includes("company")) score += TYPE_BOOST;
  return {
    type: "company",
    id: c.id,
    title: c.name,
    ...(c.origin_country ? { originCountry: c.origin_country } : {}),
    ...(c.logo_path ? { thumb: img(c.logo_path, "w185") } : {}),
    clickable: false,                     // label-only for now (see README)
    score: Math.round(score * 10) / 10,
  };
}

/** Unified ranker across people/movies/series/companies. Pure (no network). */
export function rankCandidates(
  pq: ParsedQuery, multiHits: MultiHit[], companyHits: CompanyHit[], limit = DEFAULT_SEARCH_LIMIT
): RankedResult[] {
  const scored: RankedResult[] = [];
  const seen = new Set<string>();
  for (const h of multiHits) {
    const mt = h.media_type;
    if (mt !== "person" && mt !== "movie" && mt !== "tv") continue;   // drop nothing else
    const type: ResultType = mt === "person" ? "person" : mt === "tv" ? "series" : "movie";
    const key = `${type}:${h.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push(scoreMulti(pq, h));
  }
  for (const c of companyHits) {
    const key = `company:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scored.push(scoreCompany(pq, c));
  }
  return scored
    .sort((a, b) =>
      b.score - a.score ||
      TYPE_RANK[a.type] - TYPE_RANK[b.type] ||           // people-first on exact ties
      (b.voteCount ?? 0) - (a.voteCount ?? 0) ||
      a.title.localeCompare(b.title) ||
      a.id - b.id
    )
    .slice(0, limit);
}

/** Back-compat: rank a set of /search/multi hits only (used by the tool tests). */
export function rankHits(pq: ParsedQuery, hits: MultiHit[], limit = DEFAULT_SEARCH_LIMIT): RankedResult[] {
  return rankCandidates(pq, hits, [], limit);
}

// ── Live gathering ───────────────────────────────────────────────────────────
async function multiSearchPage(query: string, page: number): Promise<MultiResponse> {
  try { return await tmdbGet<MultiResponse>("/search/multi", { query, include_adult: "false", page: String(page) }); }
  catch { return {}; }
}
async function multiSearchDeep(query: string, maxPages: number): Promise<MultiHit[]> {
  if (!query.trim()) return [];
  const first = await multiSearchPage(query, 1);
  const out = [...(first.results ?? [])];
  const pages = Math.min(maxPages, first.total_pages ?? 1);
  if (pages > 1) {
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => multiSearchPage(query, i + 2)));
    for (const r of rest) out.push(...(r.results ?? []));
  }
  return out;
}
/** Dedicated /search/{person|movie|tv} recall (tagged with media_type) so a type
 *  buried in the popularity-mixed /search/multi still enters the candidate set. */
async function typedSearch(kind: "person" | "movie" | "tv", query: string, maxPages: number): Promise<MultiHit[]> {
  if (!query.trim()) return [];
  const out: MultiHit[] = [];
  for (let p = 1; p <= maxPages; p++) {
    try {
      const res = await tmdbGet<MultiResponse>(`/search/${kind}`, { query, include_adult: "false", page: String(p) });
      for (const r of res.results ?? []) out.push({ ...r, media_type: kind });
      if (p >= (res.total_pages ?? 1)) break;
    } catch { break; }
  }
  return out;
}
async function companySearch(query: string): Promise<CompanyHit[]> {
  if (!query.trim()) return [];
  try {
    const res = await tmdbGet<CompanyResponse>("/search/company", { query });
    return res.results ?? [];
  } catch { return []; }
}

async function gatherCandidates(pq: ParsedQuery): Promise<{ multi: MultiHit[]; companies: CompanyHit[] }> {
  const hasSignal = pq.langCodes.length > 0 || pq.year !== undefined;
  const combinedPages = hasSignal ? SIGNAL_DEEP_PAGES : PLAIN_PAGES;

  const boostMovie = pq.typeBoosts.includes("movie");
  const boostSeries = pq.typeBoosts.includes("series");
  const jobs: Promise<MultiHit[]>[] = [
    multiSearchDeep(pq.queryString, combinedPages),
    typedSearch("person", pq.queryString, 2),                 // people recall (low-pop people)
    typedSearch("movie", pq.queryString, boostMovie ? 3 : 1), // movie recall (deeper if "movie" typed)
  ];
  if (boostSeries) jobs.push(typedSearch("tv", pq.queryString, 2));  // series recall when "series/show/tv" typed
  if (pq.titleTokens.length >= 2) {
    const seen = new Set([pq.queryString]);
    for (const t of pq.titleTokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      jobs.push(multiSearchDeep(t, hasSignal ? 3 : 1));
    }
  }
  const [batches, companies] = await Promise.all([Promise.all(jobs), companySearch(pq.queryString)]);
  const multi: MultiHit[] = [];
  for (const b of batches) multi.push(...b);
  return { multi, companies };
}

export interface RankedSearch {
  query: string;
  parsed: { titleTokens: string[]; languages: string[]; year?: number; typeBoosts: ResultType[]; roleDept?: string };
  count: number;
  candidates: RankedResult[];
}

export async function rankedSearch(raw: string, limit = DEFAULT_SEARCH_LIMIT): Promise<RankedSearch> {
  const pq = parseQuery(raw);
  const { multi, companies } = await gatherCandidates(pq);
  const ranked = rankCandidates(pq, multi, companies, limit);
  return {
    query: raw,
    parsed: {
      titleTokens: pq.titleTokens,
      languages: pq.langCodes.map((c) => langName(c) ?? c),
      ...(pq.year !== undefined ? { year: pq.year } : {}),
      typeBoosts: pq.typeBoosts,
      ...(pq.roleDept ? { roleDept: pq.roleDept } : {}),
    },
    count: ranked.length,
    candidates: ranked,
  };
}
