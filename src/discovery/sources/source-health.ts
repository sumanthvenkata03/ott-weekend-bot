// src/discovery/sources/source-health.ts
// CONSECUTIVE-DEGRADATION TRACKING FOR A DISCOVERY NET.
//
// ── WHY THIS EXISTS (WD-ENG-13, from the WD-ENG-12 cry-wolf audit) ──────────
// discoverOttCalendar has printed the same "degrading to []" warn on every run
// since it shipped, and has contributed ZERO films in every artifact we still
// hold. A line that is identical on run 1 and run 50 cannot tell an operator
// which one they are looking at, so it stops being read — the exact reflex
// WD-ENG-05 diagnosed on the Wikipedia coverage warn.
//
// The fix is not a louder line, it is a line that CHANGES when the situation
// changes. That requires state that outlives the process, which is what this
// module is: a tiny JSON ledger of "how many attempts in a row has this source
// failed, since when, and when did it last work".
//
// ── SHAPE BORROWED FROM issue-anchor.ts ─────────────────────────────────────
// Same discipline as the issue anchor: a small JSON file, an INJECTABLE path so
// tests never touch the real one, existsSync + try/catch on read, and a writer
// that can never throw. Losing this ledger must never cost a discovery run —
// it is diagnostic bookkeeping, not editorial data. Every failure to read or
// write degrades to "no history", which produces the pre-WD-ENG-13 wording.
//
// Deliberately NOT a table on the shared sqlite connection. The three ledgers
// that do live there (archives-featured, news_seen, radar_seen) all hold
// editorial state that must survive and be queried; this is a counter that is
// read once and written once per attempt, and keeping it out of the DB means
// it cannot participate in the WD-ENG-10C contention story at all.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Default ledger location. Under data/, which is gitignored, beside the cache. */
export const SOURCE_HEALTH_PATH = "data/source-health.json";

/**
 * Consecutive failed attempts before the wording escalates from "degraded" to
 * "dead".
 *
 * THREE, and the reasoning is worth keeping. This counter increments per ATTEMPT,
 * not per calendar run, and a single Wednesday job can attempt a source more than
 * once (getCandidates is called per edition). So 3 is not "three weeks" — it is
 * "this has now failed more times than any plausible transient". One failure is
 * noise (a blip, a timeout, a deploy); two is suspicious; three consecutive
 * failures with no success in between is a standing condition, and calling it
 * transient at that point is the lie the operator learns to ignore.
 */
export const DEAD_SOURCE_THRESHOLD = 3;

export interface SourceHealth {
  /** Failed attempts since the last success. 0 means healthy. */
  consecutiveFailures: number;
  /** ISO instant the CURRENT streak began; null when there is no streak. */
  firstFailureAt: string | null;
  /** ISO instant of the last success ever recorded; null if never. */
  lastSuccessAt: string | null;
}

const HEALTHY: SourceHealth = {
  consecutiveFailures: 0,
  firstFailureAt: null,
  lastSuccessAt: null,
};

type Ledger = Record<string, SourceHealth>;

/** Whole ledger, or {} when absent/unreadable/corrupt. Never throws. */
function readLedger(path: string): Ledger {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Ledger;
  } catch {
    return {};
  }
}

/** Best-effort persist. A failure here must never break a discovery run. */
function writeLedger(path: string, ledger: Ledger): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(ledger, null, 2), "utf8");
  } catch {
    // Intentionally silent: warning about a failed WARNING-bookkeeping write
    // would be its own cry-wolf line. The cost is one lost increment.
  }
}

/** Normalise whatever was on disk into a usable record. */
function coerce(raw: unknown): SourceHealth {
  if (!raw || typeof raw !== "object") return { ...HEALTHY };
  const r = raw as Partial<SourceHealth>;
  return {
    consecutiveFailures:
      typeof r.consecutiveFailures === "number" && Number.isFinite(r.consecutiveFailures)
        ? Math.max(0, Math.trunc(r.consecutiveFailures))
        : 0,
    firstFailureAt: typeof r.firstFailureAt === "string" ? r.firstFailureAt : null,
    lastSuccessAt: typeof r.lastSuccessAt === "string" ? r.lastSuccessAt : null,
  };
}

/** Current health for `source`. A source with no history reads as healthy. */
export function readSourceHealth(source: string, path: string = SOURCE_HEALTH_PATH): SourceHealth {
  return coerce(readLedger(path)[source]);
}

/**
 * Record one failed attempt and return the UPDATED health. `firstFailureAt` is
 * stamped only when a streak begins, so it answers "since when", not "most
 * recently".
 */
export function recordSourceFailure(
  source: string,
  path: string = SOURCE_HEALTH_PATH,
  now: Date = new Date()
): SourceHealth {
  const ledger = readLedger(path);
  const prev = coerce(ledger[source]);
  const next: SourceHealth = {
    consecutiveFailures: prev.consecutiveFailures + 1,
    firstFailureAt: prev.consecutiveFailures === 0 ? now.toISOString() : prev.firstFailureAt,
    lastSuccessAt: prev.lastSuccessAt,
  };
  ledger[source] = next;
  writeLedger(path, ledger);
  return next;
}

/**
 * Record a success: the streak resets to zero and its start is cleared. Returns
 * the health as it was BEFORE the reset, because that is what the caller needs
 * in order to say "recovered after N failures" — after the reset the number is
 * gone.
 */
export function recordSourceSuccess(
  source: string,
  path: string = SOURCE_HEALTH_PATH,
  now: Date = new Date()
): SourceHealth {
  const ledger = readLedger(path);
  const prev = coerce(ledger[source]);
  ledger[source] = {
    consecutiveFailures: 0,
    firstFailureAt: null,
    lastSuccessAt: now.toISOString(),
  };
  writeLedger(path, ledger);
  return prev;
}

/** "2026-08-14" from an ISO instant; "unknown" if unparseable. */
function day(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

/**
 * THE ONE MESSAGE BUILDER. `reason` is the path-specific fact (which of the
 * degradation modes fired); this wraps it in the streak context.
 *
 * Below the threshold the reason leads and the count is a suffix — a transient
 * should read as a transient. At or above it, the standing condition leads,
 * because by then "which mode failed this time" is the less important half.
 * Both forms keep the reason text verbatim so the distinct failure modes stay
 * distinguishable in the log either way.
 */
export function degradationLine(label: string, reason: string, health: SourceHealth): string {
  const n = health.consecutiveFailures;
  if (n < DEAD_SOURCE_THRESHOLD) {
    return `${label}: ${reason} — consecutive failed attempts: ${n}.`;
  }
  const since = day(health.firstFailureAt);
  const last = health.lastSuccessAt ? day(health.lastSuccessAt) : "never recorded";
  return (
    `⛔ ${label} is DEAD, not flaky — ${n} consecutive failed attempts since ${since}, ` +
    `last success: ${last}. This is a standing condition, not a transient: it needs repair, ` +
    `replacement, or removal from the net list. Latest failure: ${reason}`
  );
}

/** Companion to the above: said once, on the attempt that ends a real streak. */
export function recoveryLine(label: string, previous: SourceHealth): string {
  return (
    `✅ ${label} RECOVERED after ${previous.consecutiveFailures} consecutive failed ` +
    `attempt(s) (streak began ${day(previous.firstFailureAt)}).`
  );
}
