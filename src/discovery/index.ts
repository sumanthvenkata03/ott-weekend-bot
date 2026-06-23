// src/discovery/index.ts
// Discovery engine entry point. Runs both nets independently, unions and
// dedupes the candidates, and reports per-net coverage so we can SEE what
// each net missed. Purely algorithmic — no LLM.

import { log } from "../shared/logger.js";
import { discoverTmdb } from "./sources/tmdbDiscover.js";
import { discoverWikipedia } from "./sources/wikipediaList.js";
import type {
  DiscoveredFilm,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoverySource,
  TmdbCoverage,
  WikiCoverage,
} from "./types.js";

const ALL_LANGUAGES = [
  "Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Bengali", "Marathi", "Punjabi",
];

export const SUPPORTED_LANGUAGES = ALL_LANGUAGES;

/**
 * Dedupe key: normalized title + language + year. Language is REQUIRED — two
 * distinct films sharing a title+year in different languages (e.g. Drishyam 3
 * hi/ml, Vikalpa te/kn) must NOT collapse into one (that would hide a film).
 * The TMDb side is already deduped by tmdbId upstream; this key handles the
 * cross-net union (a film one net found by title also matches the other net).
 */
function dedupeKey(f: DiscoveredFilm): string {
  return `${f.normalizedTitle}|${f.language ?? ""}|${f.year ?? ""}`;
}

/** Merge `incoming` into `target` in place (same film found by another net). */
function mergeInto(target: DiscoveredFilm, incoming: DiscoveredFilm): void {
  for (const src of incoming.foundIn) {
    if (!target.foundIn.includes(src)) target.foundIn.push(src);
  }
  if (incoming.perSource.tmdb && !target.perSource.tmdb) {
    target.perSource.tmdb = incoming.perSource.tmdb;
  }
  if (incoming.perSource.wikipedia && !target.perSource.wikipedia) {
    target.perSource.wikipedia = incoming.perSource.wikipedia;
  }
  if (target.tmdbId === undefined && incoming.tmdbId !== undefined) {
    target.tmdbId = incoming.tmdbId;
  }
  if (target.releaseType === undefined && incoming.releaseType !== undefined) {
    target.releaseType = incoming.releaseType;
  }
  if (target.year === undefined && incoming.year !== undefined) {
    target.year = incoming.year;
  }
  if (target.language === undefined && incoming.language) target.language = incoming.language;

  // Prefer a concrete date over an approximate one.
  const targetApprox = !!target.approximateDate;
  const incomingApprox = !!incoming.approximateDate;
  const takeIncoming =
    (!target.releaseDate && !!incoming.releaseDate) ||
    (!!incoming.releaseDate && targetApprox && !incomingApprox);
  if (takeIncoming && incoming.releaseDate) {
    target.releaseDate = incoming.releaseDate;
    if (incomingApprox) {
      target.approximateDate = true;
    } else {
      // Concrete date now known — drop the approximate flag and its caveat.
      delete target.approximateDate;
      delete target.note;
    }
  }

  // Keep the caveat note only when the resolved date is still approximate.
  if (target.note === undefined && incoming.note !== undefined && target.approximateDate) {
    target.note = incoming.note;
  }

  // Prefer the TMDb title as the canonical display title when available.
  if (incoming.perSource.tmdb?.title) target.title = incoming.perSource.tmdb.title;
}

/** Union + dedupe a flat candidate list into one merged film per key. */
function unionFilms(candidates: DiscoveredFilm[]): DiscoveredFilm[] {
  const byKey = new Map<string, DiscoveredFilm>();
  for (const c of candidates) {
    const key = dedupeKey(c);
    const existing = byKey.get(key);
    if (existing) {
      mergeInto(existing, c);
    } else {
      // Clone so we never mutate the source-net arrays.
      byKey.set(key, {
        ...c,
        foundIn: [...c.foundIn],
        perSource: { ...c.perSource },
      });
    }
  }
  return [...byKey.values()];
}

function sortFilms(films: DiscoveredFilm[]): DiscoveredFilm[] {
  return films.sort((a, b) => {
    const da = a.releaseDate ?? "￿"; // undated sorts last
    const db = b.releaseDate ?? "￿";
    if (da !== db) return da < db ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * Cross-net sanity guard. For each (language, year) where one net found films
 * and Wikipedia found 0, escalate by WHY Wikipedia was empty:
 *  - page missing/not-created → mild log.info
 *  - page existed but parsed 0 while TMDb found >0 → LOUD warn (the silent
 *    parser-break class, e.g. the TemplateStyles <style> January bug)
 *  - fetch/parse error while TMDb found >0 → warn
 */
function crossNetGuard(tmdbCoverage: TmdbCoverage[], wikiCoverage: WikiCoverage[]): void {
  const tmdbBy = new Map<string, number>();
  for (const c of tmdbCoverage) tmdbBy.set(`${c.language}|${c.year}`, c.count);
  for (const w of wikiCoverage) {
    if (w.count > 0) continue;
    const t = tmdbBy.get(`${w.language}|${w.year}`) ?? 0;
    if (t <= 0) continue;
    if (w.status === "missing") {
      log.info(`  no Wikipedia list page for ${w.language} ${w.year} yet (TMDb found ${t})`);
    } else if (w.status === "ok") {
      log.warn(
        `⚠ COVERAGE: Wikipedia page for ${w.language} ${w.year} EXISTS but parsed 0 while ` +
          `TMDb found ${t} — possible parser break`
      );
    } else {
      log.warn(
        `⚠ COVERAGE: Wikipedia ${w.language} ${w.year} fetch/parse errored while TMDb found ${t}`
      );
    }
  }
}

/**
 * Discover films released in [from,to] for the given languages by unioning
 * the TMDb and Wikipedia nets. Never throws on a single net failure.
 */
export async function discover(query: DiscoveryQuery): Promise<DiscoveryResult> {
  const languages = query.languages.length > 0 ? query.languages : ALL_LANGUAGES;
  log.info(`Discovery: ${query.from} → ${query.to} · ${languages.join(", ")}`);

  const [tmdbRes, wikiRes] = await Promise.allSettled([
    discoverTmdb(languages, query.from, query.to),
    discoverWikipedia(languages, query.from, query.to),
  ]);

  const tmdb = tmdbRes.status === "fulfilled" ? tmdbRes.value : { films: [], coverage: [] };
  const wiki = wikiRes.status === "fulfilled" ? wikiRes.value : { films: [], coverage: [] };
  if (tmdbRes.status === "rejected") log.warn("TMDb net failed", tmdbRes.reason);
  if (wikiRes.status === "rejected") log.warn("Wikipedia net failed", wikiRes.reason);

  const tmdbFilms = tmdb.films;
  const wikiFilms = wiki.films;
  const films = sortFilms(unionFilms([...tmdbFilms, ...wikiFilms]));

  // Cross-net sanity guard (silent-drop detection).
  crossNetGuard(tmdb.coverage, wiki.coverage);

  const perNet: Record<DiscoverySource, number> = {
    tmdb: tmdbFilms.length,
    wikipedia: wikiFilms.length,
  };
  const onlyInTmdb = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "tmdb").length;
  const onlyInWikipedia = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "wikipedia").length;
  const inBoth = films.filter((f) => f.foundIn.includes("tmdb") && f.foundIn.includes("wikipedia")).length;

  // Per-language coverage — surfaces per-language zeros buried by the aggregate.
  log.info("Per-language coverage (tmdb · wiki · union):");
  for (const language of languages) {
    const t = tmdbFilms.filter((f) => f.language === language).length;
    const w = wikiFilms.filter((f) => f.language === language).length;
    const u = films.filter((f) => f.language === language).length;
    log.info(`  ${language}: tmdb ${t} · wiki ${w} · union ${u}`);
  }

  log.success(
    `Discovery: ${films.length} films (tmdb ${perNet.tmdb}, wiki ${perNet.wikipedia}; ` +
      `both ${inBoth}, tmdb-only ${onlyInTmdb}, wiki-only ${onlyInWikipedia})`
  );

  return {
    query: { ...query, languages },
    films,
    stats: {
      perNet,
      unionCount: films.length,
      onlyInTmdb,
      onlyInWikipedia,
      inBoth,
    },
    ranAt: new Date().toISOString(),
  };
}
