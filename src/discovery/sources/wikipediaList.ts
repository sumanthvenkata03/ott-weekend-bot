// src/discovery/sources/wikipediaList.ts
// Wikipedia "net": parse the "List of <Language> films of <Year>" pages.
//
// Structure (confirmed against te/2026, ta/2026, ml/2025): four quarter
// wikitables with columns  Opening | Title | Director | Cast | Production
// company | Ref.  "Opening" is a colspan=2 header over a MONTH cell and a
// DAY cell, and BOTH use rowspan — so a date's first film row carries the
// full 7 cells while later same-day rows carry only the trailing 5. We
// therefore flatten rowspans into a virtual grid (2-level propagation:
// month spans the whole month, day spans that day's films) and read
// columns by position. The year is implicit from the page title.

import { parse, type HTMLElement } from "node-html-parser";
import { ofetch } from "ofetch";
import {
  parseISO,
  isWithinInterval,
  endOfMonth,
  areIntervalsOverlapping,
} from "date-fns";
import { cached } from "../../shared/cache.js";
import { log } from "../../shared/logger.js";
import type { DiscoveredFilm, WikiCoverage, WikiNetResult } from "../types.js";
import { normalizeTitle } from "../normalize.js";

// 6h — year-lists change slowly within a window.
const WIKI_LIST_TTL = 21600;
const API = "https://en.wikipedia.org/w/api.php";
const UA = "TBSI-discovery/1.0 (editorial automation; contact webnexasolutionsllc@gmail.com)";

// Match by unique 3-letter prefix so both full ("AUGUST") and abbreviated
// ("AUG") forms resolve — Wikipedia mixes them across quarters/languages.
const MONTH_PREFIX: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

interface WikiParseResponse {
  parse?: { title: string; text: string };
  error?: { code: string; info: string };
}

/**
 * Fetch the rendered HTML of a list page via the MediaWiki parse API.
 * Cached through the shared SQLite cache. Returns "" for a missing page
 * (cached — it won't appear soon); rethrows transient fetch errors so the
 * caller's try/catch can degrade to [] without poisoning the cache. The
 * caller decides how to LOG a missing page (mild vs loud) — kept silent here
 * so logging is consistent regardless of cache hit/miss.
 */
async function fetchListHtml(page: string): Promise<string> {
  return cached<string>(
    `wiki:list:${page}`,
    async () => {
      const res = await ofetch<WikiParseResponse>(API, {
        query: {
          action: "parse",
          page,
          prop: "text",
          format: "json",
          formatversion: "2",
          redirects: "1",
        },
        headers: { "User-Agent": UA },
        retry: 2,
        retryDelay: 500,
      });
      // Discriminate the MediaWiki error code. Only a genuinely absent page
      // (missingtitle / nosuchpageid) is a permanent "no page" — return ""
      // (cached; the caller maps this to the "missing" status). ANY other code
      // (ratelimited, maxlag, readonly, …) is TRANSIENT: throw so cached() does
      // NOT persist it (a thrown loader is never written), the caller degrades
      // to status "error", and a later run retries instead of being stuck on a
      // cached "missing" for the full TTL.
      if (res.error) {
        const code = res.error.code;
        if (code === "missingtitle" || code === "nosuchpageid") return "";
        throw new Error(`Wikipedia: API error "${code}" for "${page}" (${res.error.info})`);
      }
      const text = res.parse?.text;
      // A 200 with no parse.text is a transient/unexpected shape, not a
      // permanent 404. Throw so cached() does NOT persist it — the caller
      // degrades to [] and a later run retries instead of being stuck on a
      // cached empty for the full TTL.
      if (typeof text !== "string") {
        throw new Error(`Wikipedia: unexpected response shape for "${page}"`);
      }
      return text;
    },
    { ttlSeconds: WIKI_LIST_TTL }
  );
}

/** Direct-child td/th cells of a row (ignores nested tables). */
function rowCells(tr: HTMLElement): HTMLElement[] {
  return tr.childNodes.filter(
    (n): n is HTMLElement =>
      (n as HTMLElement).tagName === "TD" || (n as HTMLElement).tagName === "TH"
  );
}

function intAttr(el: HTMLElement | null | undefined, name: string): number {
  if (!el) return 1;
  const v = Number.parseInt(el.getAttribute(name) ?? "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Flatten a table's rows into a grid of cell elements, propagating rowspan
 * (and colspan) cells DOWN/ACROSS into the positions they cover. grid[r][c]
 * is the element occupying logical column c of data-row r (header excluded).
 */
function flattenGrid(rows: HTMLElement[], numCols: number): (HTMLElement | null)[][] {
  const active: Record<number, { el: HTMLElement; remaining: number }> = {};
  const grid: (HTMLElement | null)[][] = [];
  for (const tr of rows) {
    const physical = rowCells(tr);
    let pi = 0;
    let col = 0;
    const out: (HTMLElement | null)[] = new Array(numCols).fill(null);
    while (col < numCols) {
      const carried = active[col];
      if (carried && carried.remaining > 0) {
        out[col] = carried.el;
        carried.remaining -= 1;
        col += 1;
        continue;
      }
      if (pi < physical.length) {
        const cell = physical[pi]!;
        pi += 1;
        const rs = intAttr(cell, "rowspan");
        const cs = intAttr(cell, "colspan");
        for (let c = 0; c < cs && col < numCols; c++) {
          out[col] = cell;
          if (rs > 1) active[col] = { el: cell, remaining: rs - 1 };
          col += 1;
        }
        continue;
      }
      col += 1; // gap: no physical cell and no active span
    }
    grid.push(out);
  }
  return grid;
}

function cleanText(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  // Strip inline <style>/<script> first — MediaWiki TemplateStyles inject a
  // <style> block inside the FIRST month cell (ts-vertical-text), whose CSS
  // would otherwise concatenate into element.text (e.g. "…JANUARY") and
  // break the month lookup. Later cells are deduped to empty, so without
  // this only the first month on a page silently drops its films.
  for (const noise of el.querySelectorAll("style, script")) noise.remove();
  // Drop reference superscripts before reading text.
  return el.text.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/** Title is in an <i> (often wrapping an <a>); fall back to whole cell. */
function titleOf(el: HTMLElement | null | undefined): string {
  if (!el) return "";
  const i = el.querySelector("i");
  return cleanText(i ?? el);
}

interface ResolvedDate {
  iso?: string;          // concrete yyyy-mm-dd
  monthIndex?: number;   // for approximate (month-only) overlap
  approximate: boolean;
}

function monthFromText(s: string): number | undefined {
  const key = s.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 3);
  return key in MONTH_PREFIX ? MONTH_PREFIX[key] : undefined;
}

function isoFor(year: number, monthIndex: number, day: number): string | undefined {
  if (day < 1 || day > 31) return undefined;
  // Reject days that overflow the month (e.g. Apr 31, Feb 29 in a non-leap
  // year). new Date() rolls such inputs over, so a round-trip mismatch means
  // the date is invalid. Caller then falls back to the approximate path
  // rather than emitting an invalid ISO string that would be silently dropped.
  const d = new Date(year, monthIndex, day);
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) {
    return undefined;
  }
  return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Resolve a split month/day pair (the dominant 2025/2026 layout). */
function resolveSplit(monthEl: HTMLElement | null | undefined, dayEl: HTMLElement | null | undefined, year: number): ResolvedDate | undefined {
  const monthIndex = monthFromText(cleanText(monthEl));
  if (monthIndex === undefined) return undefined;
  const dayDigits = cleanText(dayEl).replace(/[^0-9]/g, "");
  const day = Number.parseInt(dayDigits, 10);
  if (Number.isFinite(day) && day >= 1 && day <= 31) {
    const iso = isoFor(year, monthIndex, day);
    if (iso) return { iso, monthIndex, approximate: false };
  }
  return { monthIndex, approximate: true };
}

/** Defensive fallback: a single "Opening" column holding free-text dates. */
function resolveSingle(dateEl: HTMLElement | null | undefined, year: number): ResolvedDate | undefined {
  const text = cleanText(dateEl);
  if (!text) return undefined;
  const monthIndex = monthFromText(text);
  if (monthIndex === undefined) return undefined;
  const dayMatch = text.match(/\b([0-3]?\d)\b/);
  if (dayMatch) {
    const day = Number.parseInt(dayMatch[1]!, 10);
    const iso = isoFor(year, monthIndex, day);
    if (iso) return { iso, monthIndex, approximate: false };
  }
  return { monthIndex, approximate: true };
}

export interface ParseTally {
  films: DiscoveredFilm[];
  skipped: number;
}

/** Parse one already-fetched page's HTML for films within [from,to]. */
export function parsePage(htmlStr: string, language: string, year: number, page: string, from: string, to: string): ParseTally {
  const films: DiscoveredFilm[] = [];
  let skipped = 0;
  if (!htmlStr) return { films, skipped };

  const root = parse(htmlStr);
  const start = parseISO(from);
  const end = parseISO(to);
  const tables = root.querySelectorAll("table.wikitable");

  for (const table of tables) {
    const trs = table.querySelectorAll("tr");
    if (trs.length < 2) continue;
    const headerCells = rowCells(trs[0]!);
    if (headerCells.length === 0) continue;
    const firstHeader = cleanText(headerCells[0]).toLowerCase();
    // Only date tables. Skips the Box-office (Rank…) and Tamil "Upcoming
    // releases" (Title…) tables, and survives Ref/Production-company drift.
    if (!firstHeader.startsWith("opening")) continue;

    const dateSpan = intAttr(headerCells[0], "colspan"); // 2 = split month/day, 1 = single
    const titleCol = dateSpan;
    const numCols = headerCells.reduce((n, c) => n + intAttr(c, "colspan"), 0);

    const grid = flattenGrid(trs.slice(1), numCols);
    for (const r of grid) {
      const resolved =
        dateSpan >= 2 ? resolveSplit(r[0], r[1], year) : resolveSingle(r[0], year);
      const title = titleOf(r[titleCol] ?? null);
      if (!title || !resolved) {
        skipped += 1;
        continue;
      }

      let inRange = false;
      let releaseDate: string | undefined;
      let approximate = false;
      if (resolved.iso && !resolved.approximate) {
        const d = parseISO(resolved.iso);
        inRange = isWithinInterval(d, { start, end });
        releaseDate = resolved.iso;
      } else if (resolved.monthIndex !== undefined) {
        // Month-only: include if that month overlaps the query window.
        const mStart = parseISO(`${year}-${String(resolved.monthIndex + 1).padStart(2, "0")}-01`);
        const mEnd = endOfMonth(mStart);
        inRange = areIntervalsOverlapping({ start, end }, { start: mStart, end: mEnd }, { inclusive: true });
        releaseDate = `${year}-${String(resolved.monthIndex + 1).padStart(2, "0")}-01`;
        approximate = true;
      }
      if (!inRange) continue;

      films.push({
        title,
        normalizedTitle: normalizeTitle(title),
        year,
        language,
        ...(releaseDate ? { releaseDate } : {}),
        ...(approximate ? { approximateDate: true } : {}),
        foundIn: ["wikipedia"],
        perSource: {
          wikipedia: {
            title,
            ...(releaseDate ? { releaseDate } : {}),
            ...(approximate ? { approximateDate: true } : {}),
            language,
            page,
          },
        },
      });
    }
  }
  return { films, skipped };
}

function yearsInRange(from: string, to: string): number[] {
  const a = Number.parseInt(from.slice(0, 4), 10);
  const b = Number.parseInt(to.slice(0, 4), 10);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

/**
 * Wikipedia net entry point. For each language × each year the range touches,
 * fetch and parse the list page, recording per-(language, year) coverage with
 * a status so discover() can tell "no page yet" (mild) from "page existed but
 * parsed 0" (loud — the silent-parser-break class). Never throws.
 */
export async function discoverWikipedia(
  languages: string[],
  from: string,
  to: string
): Promise<WikiNetResult> {
  const years = yearsInRange(from, to);
  const films: DiscoveredFilm[] = [];
  const coverage: WikiCoverage[] = [];
  for (const language of languages) {
    for (const year of years) {
      const page = `List of ${language} films of ${year}`;
      try {
        const htmlStr = await fetchListHtml(page);
        if (htmlStr === "") {
          coverage.push({ language, year, status: "missing", count: 0 });
          log.info(`  Wikipedia [${language}/${year}] no list page (not created yet)`);
          continue;
        }
        const { films: pageFilms, skipped } = parsePage(htmlStr, language, year, page, from, to);
        films.push(...pageFilms);
        coverage.push({ language, year, status: "ok", count: pageFilms.length });
        log.info(
          `  Wikipedia [${language}/${year}] ${pageFilms.length} in range` +
            (skipped ? ` (${skipped} rows skipped)` : "")
        );
      } catch (err) {
        coverage.push({ language, year, status: "error", count: 0 });
        log.warn(`Wikipedia fetch/parse failed for "${page}"`, err instanceof Error ? err.message : err);
      }
    }
  }
  return { films, coverage };
}
