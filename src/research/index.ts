// src/research/index.ts
// Public entry point: fan out a ResearchQuery across the available sources in
// parallel and collect their RawSourceResults. One source failing (throw or
// timeout) never kills the run — it becomes { ok:false, error }.
import { log } from "../shared/logger.js";
import { availableSources } from "./registry.js";
import type {
  RawSourceResult,
  ResearchQuery,
  ResearchResult,
  SourceKind,
  SourceName,
} from "./types.js";

export interface ResearchOptions {
  /** Restrict to these source names (subset of the available set). */
  sources?: SourceName[];
  /** Restrict by kind; a "both" source qualifies for any kind. */
  only?: SourceKind;
}

function matchesKind(sourceKind: SourceKind, only?: SourceKind): boolean {
  if (!only) return true;
  if (sourceKind === "both") return true;
  return sourceKind === only;
}

export async function research(
  q: ResearchQuery,
  opts: ResearchOptions = {}
): Promise<ResearchResult> {
  let sources = availableSources();
  if (opts.sources && opts.sources.length > 0) {
    const wanted = new Set(opts.sources);
    sources = sources.filter((s) => wanted.has(s.name));
  }
  if (opts.only) {
    const only = opts.only;
    sources = sources.filter((s) => matchesKind(s.kind, only));
  }

  const settled = await Promise.allSettled(sources.map((s) => s.query(q)));
  const results: RawSourceResult[] = sources.map((s, i) => {
    const outcome = settled[i];
    if (outcome && outcome.status === "fulfilled") return outcome.value;
    const reason = outcome && outcome.status === "rejected" ? outcome.reason : "unknown error";
    return {
      source: s.name,
      kind: s.kind,
      ok: false,
      items: [],
      error: reason instanceof Error ? reason.message : String(reason),
      fetchedAt: new Date().toISOString(),
    };
  });

  const okCount = results.filter((r) => r.ok).length;
  const label = q.title || q.freeText || "(query)";
  log.info(`research '${label}' — ${results.length} sources, ${okCount} ok`);

  return {
    query: q,
    results,
    ranAt: new Date().toISOString(),
  };
}

export interface FilmInput {
  title: string;
  year?: number;
  language?: string;
  imdbId?: string;
  tmdbId?: number;
}

/** Convenience wrapper: build a ResearchQuery from a film-shaped object. */
export function researchFilm(film: FilmInput, opts?: ResearchOptions): Promise<ResearchResult> {
  const query: ResearchQuery = {
    title: film.title,
    ...(film.year !== undefined ? { year: film.year } : {}),
    ...(film.language !== undefined ? { language: film.language } : {}),
    ...(film.imdbId !== undefined ? { imdbId: film.imdbId } : {}),
    ...(film.tmdbId !== undefined ? { tmdbId: film.tmdbId } : {}),
  };
  return research(query, opts);
}

export type { ResearchQuery, ResearchResult, RawSourceResult } from "./types.js";
