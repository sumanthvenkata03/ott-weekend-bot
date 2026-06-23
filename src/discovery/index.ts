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
} from "./types.js";

const ALL_LANGUAGES = [
  "Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Bengali", "Marathi",
];

export const SUPPORTED_LANGUAGES = ALL_LANGUAGES;

/** Dedupe key: normalized title + year (year may be blank for dateless TMDb hits). */
function dedupeKey(f: DiscoveredFilm): string {
  return `${f.normalizedTitle}|${f.year ?? ""}`;
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
    if (incomingApprox) target.approximateDate = true;
    else delete target.approximateDate;
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

  const tmdbFilms = tmdbRes.status === "fulfilled" ? tmdbRes.value : [];
  const wikiFilms = wikiRes.status === "fulfilled" ? wikiRes.value : [];
  if (tmdbRes.status === "rejected") log.warn("TMDb net failed", tmdbRes.reason);
  if (wikiRes.status === "rejected") log.warn("Wikipedia net failed", wikiRes.reason);

  const films = sortFilms(unionFilms([...tmdbFilms, ...wikiFilms]));

  const perNet: Record<DiscoverySource, number> = {
    tmdb: tmdbFilms.length,
    wikipedia: wikiFilms.length,
  };
  const onlyInTmdb = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "tmdb").length;
  const onlyInWikipedia = films.filter((f) => f.foundIn.length === 1 && f.foundIn[0] === "wikipedia").length;
  const inBoth = films.filter((f) => f.foundIn.includes("tmdb") && f.foundIn.includes("wikipedia")).length;

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
