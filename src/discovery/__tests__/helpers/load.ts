// Fixture loaders. Pure fs reads of frozen fixtures — NO network, NO cache.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../__tests__/helpers
const FIX = join(HERE, "..", "fixtures");

// --- Wikipedia ---
export interface WikiParseResponse {
  parse?: { title: string; text?: string };
  error?: { code: string; info: string };
}

/** Full MediaWiki parse-API response (the shape fetchListHtml reads). */
export function loadWikiResponse(file: string): WikiParseResponse {
  return JSON.parse(readFileSync(join(FIX, "wikipedia", file), "utf8")) as WikiParseResponse;
}

/** Just the rendered HTML of a captured page (parse.text). */
export function loadWikiHtml(file: string): string {
  return loadWikiResponse(file).parse?.text ?? "";
}

/** A hand-built synthetic HTML snippet (drives parsePage directly). */
export function readSyntheticHtml(file: string): string {
  return readFileSync(join(FIX, "wikipedia", "synthetic", file), "utf8");
}

// --- TMDb ---
export interface TmdbMovie {
  id: number;
  title: string;
  release_date?: string;
}
export interface TmdbDiscoverResponse {
  page: number;
  results: TmdbMovie[];
  total_pages: number;
  total_results: number;
}

export function loadTmdb(file: string): TmdbDiscoverResponse {
  return JSON.parse(readFileSync(join(FIX, "tmdb", file), "utf8")) as TmdbDiscoverResponse;
}

/** Build a one-off discover response inline (deterministic, no file needed). */
export function tmdbPage(results: TmdbMovie[], totalPages = 1, page = 1): TmdbDiscoverResponse {
  return { page, results, total_pages: totalPages, total_results: results.length * totalPages };
}
