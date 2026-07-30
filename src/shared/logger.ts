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
//
// ── SECRET REDACTION (both sinks) ────────────────────────────────────────────
// EVERY string this module emits — to the console AND to the tee — passes
// through redactSecrets first: the message and the data payload alike. See
// shared/redact.ts for why the filter lives at the sink rather than at the ~15
// call sites that log an ofetch error message.
//
// THE RAW-OBJECT RULE. `data` used to be handed to console.log as a SECOND
// argument, which let Node's inspector format it. That bypasses any string
// filter — most importantly for `log.error("...", err)`, where the inspector
// prints the Error's full stack and its first line is the ofetch message that
// carries the key. So `data` is now stringified HERE and the resulting string is
// redacted before it reaches the console.
//
// Accepted cost: a plain object prints as compact JSON ({"a":1}) instead of the
// inspector's pretty form ({ a: 1 }). An Error is deliberately special-cased to
// its stack rather than to JSON.stringify's useless "{}", so the console loses
// no diagnostic content — it only gains the filter.
//
// The TEE's data serialisation is UNCHANGED (safeJson, as before), so a tee'd
// file differs from the console for an Error exactly as it always has; the only
// new behaviour there is redaction.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redact.js";

// Re-exported so config.ts has ONE seam to push its parsed secrets into without
// this module ever importing config (which would be a cycle).
export { registerSecrets, redactSecrets, redactSecretValues, __resetSecretRegistry } from "./redact.js";

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** IST "yyyy-MM-dd" for the log filename. See the cycle note above. */
function istDateStamp(now: Date): string {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Strip SGR colour codes so the file stays greppable. The ESC is written as the
 * explicit \x1b escape rather than an inline control byte, so the pattern
 * survives being read and rewritten by tooling that renders control characters
 * invisibly.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
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
 *
 * ANSI is stripped BEFORE redaction, so a secret cannot hide from the filter by
 * having a colour escape spliced through the middle of it.
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
    const line = `${redactSecrets(stripAnsi(msg))}${redactSecrets(stripAnsi(extra))}`;
    appendFileSync(path, `${new Date().toISOString()} ${level} ${line}\n`, "utf8");
  } catch (err) {
    teeBroken = true;
    console.error(
      redactSecrets(
        `⚠ log tee disabled — could not write ${path}: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * The CONSOLE's rendering of the optional data argument, as a string so it can
 * be filtered. An Error becomes its stack — the content the inspector used to
 * print — rather than JSON.stringify's "{}", so nothing diagnostic is lost.
 * Never throws (safeJson swallows a circular structure).
 */
function describeData(data: unknown): string {
  if (data === undefined || data === null || data === "") return "";
  if (typeof data === "string") return data;
  if (data instanceof Error) return data.stack ?? `${data.name}: ${data.message}`;
  return safeJson(data);
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

/**
 * One console line: `<stamp> <glyph> <message> <data>`.
 *
 * The single interpolated space before the data reproduces console.log's own
 * argument join byte-for-byte, so an empty data payload still prints exactly the
 * trailing space it always did.
 */
function consoleLine(glyph: string, msg: string, data: unknown): string {
  const head = `${colors.gray}${ts()}${colors.reset} ${glyph}${colors.reset} ${redactSecrets(msg)}`;
  return `${head} ${redactSecrets(describeData(data))}`;
}

export const log = {
  info: (msg: string, data?: unknown) => {
    console.log(consoleLine(`${colors.cyan}ℹ`, msg, data));
    tee("INFO", msg, data);
  },
  success: (msg: string, data?: unknown) => {
    console.log(consoleLine(`${colors.green}✓`, msg, data));
    tee("OK  ", msg, data);
  },
  warn: (msg: string, data?: unknown) => {
    console.log(consoleLine(`${colors.yellow}⚠`, msg, data));
    tee("WARN", msg, data);
  },
  error: (msg: string, err?: unknown) => {
    console.error(consoleLine(`${colors.red}✗`, msg, err));
    tee("ERR ", msg, err);
  },
};
