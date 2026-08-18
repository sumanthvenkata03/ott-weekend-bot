// src/discovery/sources/districtNet.ts
// THE DISTRICT NET — a THIRD theatrical discovery source, parse-only, no LLM.
//
// ── WHY IT EXISTS ───────────────────────────────────────────────────────────
// WD-ENG-15 found theatrical discovery running on exactly TWO nets — the TMDb
// theatrical pass and the Wikipedia year-lists — with zero redundancy. The
// two-net green rule needs two independent nets to agree, so with only two
// present, a miss by either means no theatrical film can reach green on nets
// alone. That is a worse structural hole than the OTT one WD-ENG-17 closed, and
// it is why Panchali Panchabhartruka and Pallaburusu were unreportable.
//
// District (Zomato) was the only surveyed source carrying BOTH of those films
// with the correct date and language. It answers 200 to the project UA (unlike
// BookMyShow and Letterboxd, which 403 it), robots.txt permits /movies, and it
// publishes a movies sitemap.
//
// ── WHY IT NEEDS NO LLM, AND WHY THAT MATTERS ───────────────────────────────
// Every District movie detail page carries a complete schema.org/Movie JSON-LD
// block: `name`, `datePublished` (already ISO), `inLanguage`, `genre`,
// `description`, `director`, `actor`, `image`. That is a structured record, so
// this net PARSES rather than extracts. WD-ENG-17D removed the news net from the
// theatrical intent precisely because its extraction cost a billed Anthropic
// call on all four theatrical pillars; this net reintroduces theatrical
// redundancy while keeping Mon Movement, Sat Verdict, Sun Spotlight and Fri
// Archives at ZERO Anthropic calls. A pin asserts it imports no Claude client.
//
// ── COST PER RUN ────────────────────────────────────────────────────────────
// ONE listing fetch (/movies, ~46 unique film ids) plus ONE detail fetch per
// listed film — about 47 free, cached (6h) HTTP requests. No key, no quota, no
// LLM. Bounded by MAX_DETAIL_FETCHES so a listing that suddenly grows cannot
// turn into an unbounded sweep.
import { parse } from "node-html-parser";
import { fetchCached } from "../../research/http.js";
import { log } from "../../shared/logger.js";
import { normalizeTitle } from "../normalize.js";
import {
  recordSourceFailure,
  recordSourceSuccess,
  degradationLine,
  recoveryLine,
} from "./source-health.js";
import type { DiscoveredFilm } from "../types.js";

const SOURCE_KEY = "district-net";
const SOURCE_LABEL = "District net";

const LISTING_URL = "https://www.district.in/movies";
const LISTING_TTL = 21600; // 6h
const DETAIL_TTL = 86400;  // 24h — a released film's record does not move

/** Hard bound on the per-run sweep. A listing that grows cannot run away. */
export const MAX_DETAIL_FETCHES = 80;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The seven pillar languages, as elsewhere in discovery. */
const PILLAR_LANGUAGES = new Set([
  "telugu", "tamil", "malayalam", "kannada", "hindi", "marathi", "punjabi",
]);

export interface DistrictListingEntry {
  /** Stable District id, e.g. "MV229841" — the dedupe key for the sweep. */
  id: string;
  slug: string;
  url: string;
}

/**
 * Parse the /movies listing into unique film links. PURE.
 *
 * The listing carries titles and URLs but NO dates and NO languages — verified
 * live: it contains neither "Released" nor any "<d> August 2026"-shaped string.
 * That is why the detail fetch below is required rather than an optimisation.
 */
export function parseListing(html: string): DistrictListingEntry[] {
  const out = new Map<string, DistrictListingEntry>();
  const re = /href="(https:\/\/www\.district\.in\/movies\/([a-z0-9-]+)-movie-tickets-(MV\d+))"/g;
  for (const m of html.matchAll(re)) {
    const [, url, slug, id] = m;
    if (!id || !slug || !url || out.has(id)) continue;
    out.set(id, { id, slug, url });
  }
  return [...out.values()];
}

/** The subset of schema.org/Movie this net reads. Everything else is ignored. */
export interface DistrictMovie {
  name: string;
  datePublished?: string;
  inLanguage?: string[];
  genre?: string[];
  description?: string;
  director?: string;
  actors?: string[];
  image?: string;
}

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : [];

const namesOf = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr
    .map((x) => (x && typeof x === "object" && "name" in x ? String((x as { name: unknown }).name) : ""))
    .filter(Boolean);
};

/**
 * Pull the schema.org/Movie block out of a detail page. PURE.
 *
 * Returns null when the page carries no Movie block — a cinema page, a generic
 * listing, or a layout change. Null is the honest answer; the caller drops the
 * entry rather than guessing at the HTML.
 */
export function parseMovieJsonLd(html: string): DistrictMovie | null {
  const root = parse(html);
  for (const node of root.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.text);
    } catch {
      continue; // a malformed block is skipped, never fatal
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      const o = b as Record<string, unknown>;
      if (o["@type"] !== "Movie" || typeof o.name !== "string") continue;
      return {
        name: o.name,
        ...(typeof o.datePublished === "string" ? { datePublished: o.datePublished } : {}),
        inLanguage: asArray(o.inLanguage),
        genre: asArray(o.genre),
        ...(typeof o.description === "string" ? { description: o.description } : {}),
        ...(namesOf(o.director)[0] ? { director: namesOf(o.director)[0]! } : {}),
        actors: namesOf(o.actor),
        ...(typeof o.image === "string" ? { image: o.image } : {}),
      };
    }
  }
  return null;
}

/**
 * PART 3 GUARD, IN CODE — a listing with no usable date cannot produce a dated
 * candidate.
 *
 * Same discipline as the news net's hasUsableDate. District's `datePublished`
 * is already ISO when present; anything else — absent, a year only, prose — is
 * refused rather than coerced. A film with no date cannot be placed in a window,
 * and inventing one is the Filmibeat failure this codebase keeps paying for.
 */
export function hasUsableDate(m: DistrictMovie): boolean {
  return typeof m.datePublished === "string" && ISO.test(m.datePublished);
}

/** Map District's language string onto a pillar language, else undefined. */
export function pillarLanguage(inLanguage: string[] | undefined): string | undefined {
  for (const raw of inLanguage ?? []) {
    const k = raw.trim().toLowerCase();
    if (PILLAR_LANGUAGES.has(k)) return k.charAt(0).toUpperCase() + k.slice(1);
  }
  return undefined;
}

/** True when `date` falls inside [from,to] inclusive. String compare is safe on ISO. */
export function inWindow(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/** Build the DiscoveredFilm. Its OWN provenance tag, so corroboration counts it. */
export function toDiscoveredFilm(m: DistrictMovie, language: string, url: string): DiscoveredFilm {
  const date = m.datePublished!;
  return {
    title: m.name,
    normalizedTitle: normalizeTitle(m.name),
    year: Number.parseInt(date.slice(0, 4), 10),
    language,
    releaseDate: date,
    // NO releaseType and NO tmdbId — deliberately, and this is the whole of
    // Part 3's second guard. releaseType is what matchesIntent keys on, so
    // setting it here would admit a TMDb-less film straight into the pool and
    // create exactly the exception this net must not create. Left undefined, a
    // District find is indistinguishable from a Wikipedia-only find: it goes
    // through resolveWikiOnlyFilms, becomes a candidate only if TMDb resolves
    // it, and is otherwise declined with the same log line.
    sourceUrl: url,
    foundIn: ["district"],
    perSource: {},
  };
}

/**
 * THE NET. Theatrical only, parse-only, fail-safe and additive.
 *
 * NOTE ON TMDb BACKING: this net emits films with NO tmdbId, exactly as the
 * Wikipedia net does. It does NOT create an exception to the TMDb-backed pool
 * rule — candidates.ts still runs resolveWikiOnlyFilms and still drops a find
 * that never resolves. What this net widens is DISCOVERY, not admission. That is
 * pinned.
 */
export async function discoverDistrict(from: string, to: string): Promise<DiscoveredFilm[]> {
  const degrade = (reason: string): DiscoveredFilm[] => {
    log.warn(degradationLine(SOURCE_LABEL, reason, recordSourceFailure(SOURCE_KEY)));
    return [];
  };

  let listing: string;
  try {
    const { value } = await fetchCached<string>("discovery:district:listing", LISTING_URL, {
      ttlSeconds: LISTING_TTL,
      responseType: "text",
    });
    listing = value;
  } catch (err) {
    return degrade(
      `listing fetch failed — degrading to [] (other theatrical nets unaffected): ` +
        `${err instanceof Error ? err.message : String(err)}`
    );
  }

  const entries = parseListing(listing);
  if (entries.length === 0) {
    return degrade(
      `⚠ COVERAGE: listing fetched OK (${listing.length} chars) but parsed 0 film links — ` +
        `possible layout change (${LISTING_URL})`
    );
  }

  const sweep = entries.slice(0, MAX_DETAIL_FETCHES);
  if (entries.length > sweep.length) {
    // Never a silent cap — WD-ENG-13's "no silent truncation" rule.
    log.warn(
      `  District net: listing had ${entries.length} films; sweeping the first ${sweep.length} ` +
        `(MAX_DETAIL_FETCHES). Raise the bound deliberately if this is now normal.`
    );
  }

  const films: DiscoveredFilm[] = [];
  let undated = 0;
  let nonPillar = 0;
  let outOfWindow = 0;
  let noMovieBlock = 0;
  let failed = 0;

  for (const e of sweep) {
    let detail: string;
    try {
      const { value } = await fetchCached<string>(`discovery:district:detail:${e.id}`, e.url, {
        ttlSeconds: DETAIL_TTL,
        responseType: "text",
      });
      detail = value;
    } catch {
      failed++;                       // one bad detail page never sinks the sweep
      continue;
    }

    const movie = parseMovieJsonLd(detail);
    if (!movie) {
      noMovieBlock++;
      continue;
    }
    // PART 3, ENFORCED: no usable date ⇒ no candidate, dated or otherwise.
    if (!hasUsableDate(movie)) {
      undated++;
      continue;
    }
    if (!inWindow(movie.datePublished!, from, to)) {
      outOfWindow++;
      continue;
    }
    const language = pillarLanguage(movie.inLanguage);
    if (!language) {
      nonPillar++;                    // English/other — not a pillar language
      continue;
    }
    films.push(toDiscoveredFilm(movie, language, e.url));
  }

  log.info(
    `District net: ${entries.length} listed → ${sweep.length} swept → ${films.length} in-window ` +
      `pillar film(s)  [dropped: ${outOfWindow} out-of-window, ${nonPillar} non-pillar, ` +
      `${undated} undated, ${noMovieBlock} no-Movie-block, ${failed} fetch-failed]`
  );

  const before = recordSourceSuccess(SOURCE_KEY);
  if (before.consecutiveFailures > 0) log.success(recoveryLine(SOURCE_LABEL, before));

  return films;
}
