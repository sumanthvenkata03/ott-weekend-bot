// src/content/weekend/research-archive.ts
// Durable, git-ignored archive of Saturday verdict research. The research cache
// has a 24h TTL (blobs are purged at job start), so it is NOT a historical
// corpus — this persists each run's RAW research blob + a per-verdict log line
// to build a permanent backtest set going forward.
//
// JOB PATH ONLY (never a render:* path). Does ZERO network — it only writes what
// the run already computed. Both functions are NO-THROW: archival may never
// break a run, so every failure is swallowed to a log.warn.

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../shared/logger.js";
import { editorialTodayStamp } from "../../shared/editorial-clock.js";
import type { RawResearch, GroundedVerdict, Confidence } from "./verdict-research.js";

const ARCHIVE_ROOT = join("data", "research-archive");
const RAW_DIR = join(ARCHIVE_ROOT, "raw");

/** YYYY-MM-DD of the IST editorial date for dated filenames — was UTC-only, so a
 *  run in the 18:30–24:00Z window used to file under the previous IST day. */
function todayStamp(): string {
  return editorialTodayStamp();
}

/** Make a cache key safe for a Windows filename — the "title|date" keys contain
 *  '|' and every key contains ':', both illegal on Windows. */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Persist ONE raw research blob as pretty JSON at
 * data/research-archive/raw/{YYYY-MM-DD}--{sanitized-key}.json.
 * WRITE-IF-ABSENT (never overwrites an existing snapshot). No-throw.
 */
export function archiveRawResearch(cacheKey: string, raw: RawResearch): void {
  try {
    mkdirSync(RAW_DIR, { recursive: true });
    const file = join(RAW_DIR, `${todayStamp()}--${sanitizeKey(cacheKey)}.json`);
    if (existsSync(file)) return; // write-if-absent — immutable per (day, key)
    writeFileSync(file, JSON.stringify(raw, null, 2), "utf8");
  } catch (err) {
    log.warn(`archiveRawResearch(${cacheKey}) failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface VerdictLogEntry {
  runAt: string;
  title: string;
  imdbId: string | undefined;
  criticCount: number;
  tbsiScore: number | null;
  star: number | null;
  verdict: GroundedVerdict | null;
  confidence: Confidence;
}

/**
 * Append ONE JSON line to data/research-archive/verdicts-{YYYY-MM-DD}.jsonl.
 * No-throw. undefined fields (e.g. imdbId) are dropped by JSON.stringify.
 */
export function appendVerdictLog(entry: VerdictLogEntry): void {
  try {
    mkdirSync(ARCHIVE_ROOT, { recursive: true });
    const file = join(ARCHIVE_ROOT, `verdicts-${todayStamp()}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    log.warn(`appendVerdictLog(${entry.title}) failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}
