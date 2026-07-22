// src/shared/logger.ts
//
// ── LOG TEE (TBSI_LOG_FILE) ──────────────────────────────────────────────────
// OPT-IN. Unset ⇒ this module behaves exactly as before: console only, zero
// filesystem access, zero added latency. Set ⇒ every log.* line is ALSO appended
// to a file, ANSI-stripped, with a full ISO timestamp (the console keeps its
// short HH:MM:SS form).
//
// WHY: a scheduled Wednesday run's diagnosis was crippled by having no stdout
// anywhere. The manifest survives; the reasoning that produced it did not.
//
// Accepts either shape:
//   TBSI_LOG_FILE=logs                  → logs/tbsi-YYYY-MM-DD.log   (dated)
//   TBSI_LOG_FILE=logs/my-run.log       → that exact file
//
// The date is the IST calendar date, computed INLINE rather than via
// editorial-clock — that module imports THIS one, so calling into it here would
// create an import cycle. The +5:30 shift is duplicated deliberately and is the
// only arithmetic here; everything editorial still goes through the clock.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** IST "yyyy-MM-dd" for the log filename. See the cycle note above. */
function istDateStamp(now: Date): string {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Strip SGR colour codes so the file stays greppable. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

let resolvedPath: string | null = null;
let resolvedFor: string | undefined;
let teeBroken = false;

/** Resolve TBSI_LOG_FILE at CALL time (so tests can set/unset it freely). */
function teePath(): string | null {
  const raw = process.env.TBSI_LOG_FILE?.trim();
  if (!raw) return null;
  if (resolvedPath !== null && resolvedFor === raw) return resolvedPath;
  resolvedFor = raw;
  resolvedPath = raw.endsWith(".log") ? raw : join(raw, `tbsi-${istDateStamp(new Date())}.log`);
  return resolvedPath;
}

/**
 * Append one line to the tee. NEVER throws and never retries after a hard
 * failure: a broken log sink must not take down a publishing run. The first
 * failure warns on the console once, then the tee goes quiet.
 */
function tee(level: string, msg: string, data?: unknown): void {
  const path = teePath();
  if (path === null || teeBroken) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const extra =
      data === undefined || data === null || data === ""
        ? ""
        : ` ${typeof data === "string" ? data : safeJson(data)}`;
    appendFileSync(path, `${new Date().toISOString()} ${level} ${stripAnsi(msg)}${stripAnsi(extra)}\n`, "utf8");
  } catch (err) {
    teeBroken = true;
    console.error(`⚠ log tee disabled — could not write ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Test seam — forget the memoised path/broken flag between cases. */
export function __resetLogTee(): void {
  resolvedPath = null;
  resolvedFor = undefined;
  teeBroken = false;
}

const colors = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function ts() {
  return new Date().toISOString().split("T")[1].slice(0, 8);
}

export const log = {
  info: (msg: string, data?: unknown) => {
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.cyan}ℹ${colors.reset} ${msg}`, data ?? "");
    tee("INFO", msg, data);
  },
  success: (msg: string, data?: unknown) => {
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.green}✓${colors.reset} ${msg}`, data ?? "");
    tee("OK  ", msg, data);
  },
  warn: (msg: string, data?: unknown) => {
    console.log(`${colors.gray}${ts()}${colors.reset} ${colors.yellow}⚠${colors.reset} ${msg}`, data ?? "");
    tee("WARN", msg, data);
  },
  error: (msg: string, err?: unknown) => {
    console.error(`${colors.gray}${ts()}${colors.reset} ${colors.red}✗${colors.reset} ${msg}`, err ?? "");
    tee("ERR ", msg, err);
  },
};