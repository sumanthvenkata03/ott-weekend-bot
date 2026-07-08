// scripts/movie-lookup/verdicts-export.ts
// Manual exporter: reads the pipeline's durable verdict log (JSONL under
// data/research-archive/) and writes scripts/movie-lookup/verdict-data/verdicts.json —
// the data the site's GET /api/verdicts serves and movie.html links its verdict field
// from. The log already carries every data field (runAt/title/imdbId/criticCount/
// tbsiScore/star/verdict/confidence), so NO re-scoring of the raw archive blobs is
// needed; getIssueNumber is imported READ-ONLY from src/ to derive the issue string.
//
// Run manually (READ-ONLY of the archive; writes only verdict-data/verdicts.json):
//   npx tsx scripts/movie-lookup/verdicts-export.ts
//
// The pure functions (parseLogLines / latestPerFilm / deriveIssue / mergeVerdicts /
// safeReadVerdicts) are exported and unit-tested in verdicts.check.ts; file/console I/O
// lives in main(), which runs only when this file is invoked directly.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getIssueNumber } from "../../src/shared/issue-number.js";

export type Verdict = "Must Watch" | "Worth a Try" | "Divisive" | "Skip";
export type Confidence = "high" | "medium" | "low";

/** One parsed line of the verdict log (data/research-archive/verdicts-*.jsonl). */
export interface LogEntry {
  runAt: string;
  title: string;
  imdbId?: string;
  criticCount: number;
  tbsiScore: number | null;
  star: number | null;
  verdict: Verdict | null;
  confidence: Confidence;
}

/** One row of the site's verdicts.json. */
export interface VerdictRow {
  imdbId: string | null;
  title: string;
  star: number | null;
  tbsiScore: number | null;
  verdict: Verdict;
  confidence: Confidence;
  criticCount: number;
  runAt: string;
  issue: string | null;
  igUrl: string | null;
}

export interface VerdictsFile {
  updatedAt: string | null;
  verdicts: VerdictRow[];
}

/** Parse JSONL text → entries. Blank and unparseable lines are skipped. */
export function parseLogLines(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as LogEntry;
      if (o && typeof o.title === "string" && typeof o.runAt === "string") out.push(o);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/** Latest entry per film (key = imdbId else title), dropping verdict===null (no-score runs). */
export function latestPerFilm(entries: LogEntry[]): LogEntry[] {
  const best = new Map<string, LogEntry>();
  for (const e of entries) {
    if (e.verdict === null || e.verdict === undefined) continue; // no-score run — skip
    const key = e.imdbId || `title:${e.title}`;
    const prev = best.get(key);
    if (!prev || e.runAt > prev.runAt) best.set(key, e);
  }
  return [...best.values()];
}

/**
 * The verdict's SATURDAY issue. Verdicts are the Sat pillar, so map runAt's day to the
 * relevant Saturday: Fri→+1, Sat→+0, Sun→−1, otherwise the coming Saturday. UTC
 * throughout (getUTCDay), consistent with getIssueNumber's UTC arithmetic. Bad date → null.
 */
export function deriveIssue(runAt: string): string | null {
  const d = new Date(runAt);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const delta = dow === 5 ? 1 : dow === 6 ? 0 : dow === 0 ? -1 : 6 - dow;
  const sat = new Date(d);
  sat.setUTCDate(sat.getUTCDate() + delta);
  return getIssueNumber(sat);
}

/**
 * Merge fresh log-derived rows into existing verdicts.json rows. Fresh wins on data
 * fields, BUT the existing igUrl (manually curated) is preserved; existing rows absent
 * from the fresh set survive (manual entries). Key = imdbId else title.
 */
export function mergeVerdicts(existing: VerdictRow[], fresh: VerdictRow[]): VerdictRow[] {
  const key = (r: VerdictRow) => r.imdbId || `title:${r.title}`;
  const byKey = new Map<string, VerdictRow>();
  for (const r of existing) byKey.set(key(r), r);
  for (const f of fresh) {
    const prev = byKey.get(key(f));
    byKey.set(key(f), { ...f, igUrl: prev?.igUrl ?? f.igUrl ?? null }); // fresh data wins; igUrl preserved
  }
  return [...byKey.values()];
}

/** Read verdicts.json defensively — missing/invalid file → the empty shape (never throws). */
export function safeReadVerdicts(file: string): VerdictsFile {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as VerdictsFile;
    if (parsed && Array.isArray(parsed.verdicts)) return { updatedAt: parsed.updatedAt ?? null, verdicts: parsed.verdicts };
  } catch { /* missing / invalid → empty shape */ }
  return { updatedAt: null, verdicts: [] };
}

/** Build a fresh VerdictRow from a log entry (igUrl always null — filled manually later). */
export function toRow(e: LogEntry): VerdictRow {
  return {
    imdbId: e.imdbId ?? null,
    title: e.title,
    star: e.star ?? null,
    tbsiScore: e.tbsiScore ?? null,
    verdict: e.verdict as Verdict,
    confidence: e.confidence,
    criticCount: e.criticCount,
    runAt: e.runAt,
    issue: deriveIssue(e.runAt),
    igUrl: null,
  };
}

// ── main (manual run only) ────────────────────────────────────────────────────
function main(): void {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ARCHIVE = join(HERE, "..", "..", "data", "research-archive");
  const OUT_DIR = join(HERE, "verdict-data");
  const OUT = join(OUT_DIR, "verdicts.json");

  const entries: LogEntry[] = [];
  if (existsSync(ARCHIVE)) {
    for (const f of readdirSync(ARCHIVE)) {
      if (/^verdicts-.*\.jsonl$/.test(f)) entries.push(...parseLogLines(readFileSync(join(ARCHIVE, f), "utf8")));
    }
  }
  const fresh = latestPerFilm(entries).map(toRow);

  const existing = existsSync(OUT) ? safeReadVerdicts(OUT).verdicts : [];
  const merged = mergeVerdicts(existing, fresh).sort((a, b) => (a.runAt < b.runAt ? 1 : -1)); // newest first

  mkdirSync(OUT_DIR, { recursive: true });
  const file: VerdictsFile = { updatedAt: new Date().toISOString(), verdicts: merged };
  writeFileSync(OUT, JSON.stringify(file, null, 2) + "\n", "utf8");

  console.log(`\nExported ${merged.length} verdict row(s) → ${OUT}\n`);
  console.table(merged.map((r) => ({ title: r.title, imdbId: r.imdbId, verdict: r.verdict, star: r.star, issue: r.issue, igUrl: r.igUrl ? "set" : "—" })));
  console.log("\nReminders:");
  console.log("  • CURATE — remove rows you did not actually publish.");
  console.log("  • Fill igUrl manually for the ones printed in an issue (the site links ONLY when igUrl is set).");
  console.log("  • Commit scripts/movie-lookup/verdict-data/verdicts.json.\n");
}

// Run only when invoked directly (never when imported by the tests / the server).
const isMain = import.meta.url.endsWith((process.argv[1] ?? "").replace(/\\/g, "/"));
if (isMain) main();
