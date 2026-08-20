// src/shared/verdict-ledger.ts
// WD-ENG-22A — THE VERDICT LEDGER. Persistence for AI-review CONFIRMS.
//
// ── THE CLASS THIS KILLS ────────────────────────────────────────────────────
// The AI-review cache (ai-review.ts, AI_REVIEW_CACHE_VERSION) is keyed by the
// exact projected film set and lives 24 hours. That is the right lifetime for
// the --approve determinism spine and the WRONG lifetime for a FACT. A film
// that a trade-press source confirmed on Wednesday is re-searched from scratch
// the following Wednesday, and the second search is a fresh roll of the dice:
// the same film has come back "confirm" one week and "unverified" the next
// purely because the query surfaced different pages. That week-to-week FLIP is
// what removes a real film from a real deck.
//
// A confirm is not a cache entry. It is a dated, sourced observation: "on
// <confirmed_at>, <source_url> corroborated this release for the window ending
// <window_end>." This table stores exactly that, and nothing else.
//
// ── ONLY CONFIRMS ARE EVER WRITTEN ──────────────────────────────────────────
// A negative is not a fact about the film, it is a fact about the search — a
// "doubt"/"unverified"/"reject" says the query did not find corroboration THIS
// time, and persisting that would build the mirror-image failure: a film
// permanently condemned by one bad week of search results. A film with no row
// simply bills, exactly as it does today. The ledger can therefore only ever
// SAVE a call; it can never cause a removal that would not have happened.
//
// ── AND A CONFIRM IS REVOCABLE ──────────────────────────────────────────────
// Three independent mechanisms take a row back out:
//   1. TTL — every row expires (VERDICT_TTL_DAYS, default 14). No fact about a
//      release date is allowed to outlive the release by much.
//   2. CONSULT-TIME VOIDING — a row whose film now carries a contradiction
//      (date conflict, suppressed platform, retro-denylisted source, a date
//      that has moved past the window the confirm covered, a different pillar)
//      is DELETED and the film bills. See classifyLedgerConsult.
//   3. POST-ENFORCEMENT VOIDING — a film that ends the run demoted has its row
//      deleted, so a stale confirm cannot resurrect it next week.
//
// ── AUTHORITY BOUNDARY (unchanged from ai-review.ts) ────────────────────────
// A ledger hit produces the SAME `aiReview` annotation a billed call would
// have produced, so enforcement, the gate hash and the auto-publish predicate
// all see exactly what they saw before. The ledger changes WHERE a verdict
// comes from, never WHAT the pipeline does with it. In particular it cannot
// reach checkpoint 2 (autonomy.confirmAutoPublish reads the manifest only).
//
// Mirrors featured-ledger.ts: shared sqlite connection from cache.ts, its own
// table, lazy getStmts() so importing the pure helpers touches no database.

import type { Statement } from "better-sqlite3";
import { db } from "./cache.js";
// TYPE-ONLY, so this stays a leaf at runtime: reconcile/types.ts is pure types
// (its own only import is a type import of shared/types.js), so the reference
// is erased by tsc and no shared -> reconcile runtime edge is created.
import type { AiVerdict, SourceDomainTrust, TrustVerdict } from "../reconcile/types.js";

// ── TTL ─────────────────────────────────────────────────────────────────────

export const DEFAULT_VERDICT_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the VERDICT_TTL_DAYS dial. A POSITIVE INTEGER wins; anything else —
 * unset, blank, "0", "-3", "7.5", "1e3", "many" — falls back to the default.
 *
 * The strict `^\d+$` (rather than Number()) is the point: `Number(" 7 ")` is 7
 * but `Number("7.5")` is 7.5 and `Number("1e3")` is 1000, and a TTL silently
 * becoming 1000 days would disable revocation-by-expiry without ever failing.
 * A malformed dial must degrade to the SAFE default, never to a longer life.
 */
export function parseTtlDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_VERDICT_TTL_DAYS;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return DEFAULT_VERDICT_TTL_DAYS;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_VERDICT_TTL_DAYS;
}

/** The live TTL in days, read from process.env at CALL time (never at import). */
export function verdictTtlDays(): number {
  return parseTtlDays(process.env.VERDICT_TTL_DAYS);
}

/** The live TTL in milliseconds. */
export function verdictTtlMs(): number {
  return verdictTtlDays() * DAY_MS;
}

// ── The row ─────────────────────────────────────────────────────────────────

/** One persisted CONFIRM. Column names are the sqlite ones, verbatim. */
export interface VerdictRow {
  /** ai-review's `reviewRef` — `tmdb-<id>` / `manual-<slug>` / `disc-<slug>`. */
  ref: string;
  /** The film's TMDb id, or null for an operator add / TMDb-less find. */
  tmdb_id: number | null;
  /** Always "confirm" today; stored rather than assumed so the column stays honest. */
  verdict: AiVerdict;
  /** Always "confirmed" today, for the same reason. */
  trust: TrustVerdict;
  /** The cite. A confirm with no source is never written (see qualifiesForLedger). */
  source_url: string;
  /** classifyDomainTrust(source_url) AT WRITE TIME. Re-checked on consult. */
  source_domain_trust: SourceDomainTrust;
  confirmed_at: number;
  expires_at: number;
  /** The window END the confirm covered, ISO "yyyy-MM-dd". */
  window_end: string;
  /** The pillar that billed for it ("theatrical" / "ott"). */
  pillar: string;
}

// ── PURE: what may be written ───────────────────────────────────────────────

/** The write-time shape ai-review hands over (a subset of AiReviewVerdict). */
export interface WriteCandidate {
  verdict: AiVerdict;
  trust?: TrustVerdict;
  sourceUrl?: string;
  sourceDomainTrust?: SourceDomainTrust;
}

/**
 * CONFIRMS ONLY, and only SOURCED ones from a non-denylisted domain.
 *
 * All four conditions are checked independently rather than collapsed into
 * `trust === "confirmed"`: trust is DERIVED from the other three upstream
 * (trustVerdictFor), and a ledger row outlives the code that derived it. If the
 * derivation ever changes, the row must still be one this predicate would
 * accept on its own terms.
 */
export function qualifiesForLedger(v: WriteCandidate): boolean {
  return (
    v.verdict === "confirm" &&
    v.trust === "confirmed" &&
    v.sourceDomainTrust !== "deny" &&
    typeof v.sourceUrl === "string" &&
    v.sourceUrl.length > 0
  );
}

// ── PURE: the consult decision ──────────────────────────────────────────────

/**
 * The demotion classes that REVOKE a stored confirm. Every class enforcement
 * can produce is listed — a demoted film has, by definition, not been shown to
 * be releasing as claimed, whatever a row from last week says.
 */
export const VOIDING_DEMOTION_CLASSES: ReadonlyArray<string> = [
  "contradicted",
  "unconfirmed",
  "platform-conflict",
  "no-platform",
];

export type LedgerConsult =
  /** Fresh, uncontradicted — apply the stored verdict, skip the billed call. */
  | { kind: "hit"; row: VerdictRow }
  /** Contradicted at consult time — DELETE the row, then bill. */
  | { kind: "void"; reason: string }
  /** Past its TTL — bill, keep the row for the flip-visibility comparison. */
  | { kind: "expired"; row: VerdictRow }
  /** No row, or a film the ledger deliberately declines to cover — bill. */
  | { kind: "miss"; reason: string };

/** Everything the consult decision needs about the film, computed by the caller. */
export interface ConsultContext {
  /** The pillar of the edition doing the consulting. */
  pillar: string;
  /** The film's CURRENT date, if it has one ("yyyy-MM-dd"). */
  filmDate: string | undefined;
  /** Reconcile recorded a date conflict on this film. */
  hasConflictDetail: boolean;
  /** A platform on this film has already been suppressed. */
  platformSuppressed: boolean;
  /** classifyDomainTrust(row.source_url) recomputed NOW — see below. */
  sourceDeniedNow: boolean;
  now: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is the film's CURRENT date still covered by the window the confirm was made
 * for? A stored row means "corroborated for the window ending W". If the film's
 * date has since moved PAST W, the confirm no longer speaks to the claim on the
 * table and must not be reused — that re-dating is precisely the event the
 * ledger must not paper over.
 *
 * A film with no date cannot contradict the row (nothing to compare), so it
 * stays covered. A NON-ISO value on either side is treated as inconsistent:
 * when the comparison cannot be made, bill. Every bias in this module runs
 * toward paying for a call rather than reusing a fact we cannot justify.
 */
export function dateWithinLedgerWindow(filmDate: string | undefined, windowEnd: string): boolean {
  if (filmDate === undefined) return true;
  if (!ISO_DATE.test(filmDate) || !ISO_DATE.test(windowEnd)) return false;
  return filmDate <= windowEnd;   // ISO dates compare lexicographically
}

/**
 * THE CONSULT DECISION. Pure: every input is a value, so a review run and its
 * --approve re-run classify identically.
 *
 * Order matters. VOIDING is checked BEFORE expiry, because a contradicted row
 * must be deleted whether or not it had also aged out — leaving a contradicted
 * row in place to expire quietly would let it feed the flip-visibility log as
 * though it had merely gone stale.
 */
export function classifyLedgerConsult(
  row: VerdictRow | undefined,
  ctx: ConsultContext
): LedgerConsult {
  if (!row) return { kind: "miss", reason: "no row" };

  // ── VOIDING (delete + bill) ───────────────────────────────────────────────
  if (ctx.hasConflictDetail) return { kind: "void", reason: "film carries a date conflict" };
  if (ctx.platformSuppressed) return { kind: "void", reason: "film's platform was suppressed" };
  // Stored trust AND a fresh re-classification. The stored value is what the
  // denylist said on the day; the fresh one is what it says now. Adding a
  // domain to DENYLIST_DOMAINS/PATTERNS must retroactively invalidate every
  // confirm that leaned on it — otherwise the denylist protects only the films
  // reviewed after the edit, which is the wrong half.
  if (row.source_domain_trust === "deny" || ctx.sourceDeniedNow) {
    return { kind: "void", reason: "source domain is denylisted" };
  }
  // A theatrical confirm does not corroborate an OTT arrival: they are
  // different claims about different dates. `ref` is the table's primary key
  // (one row per film), so the guard lives here rather than in the schema.
  if (row.pillar !== ctx.pillar) {
    return { kind: "void", reason: `row belongs to pillar ${row.pillar}, not ${ctx.pillar}` };
  }
  if (!dateWithinLedgerWindow(ctx.filmDate, row.window_end)) {
    return { kind: "void", reason: `film date ${ctx.filmDate ?? "?"} is past the confirmed window end ${row.window_end}` };
  }

  // ── TTL ───────────────────────────────────────────────────────────────────
  if (row.expires_at <= ctx.now) return { kind: "expired", row };

  return { kind: "hit", row };
}

// ── Storage ─────────────────────────────────────────────────────────────────

interface Stmts {
  get: Statement;
  upsert: Statement;
  del: Statement;
  clear: Statement;
}

let stmts: Stmts | null = null;

function getStmts(): Stmts {
  if (stmts) return stmts;
  db.exec(`
    CREATE TABLE IF NOT EXISTS verdict_ledger (
      ref                 TEXT PRIMARY KEY,
      tmdb_id             INTEGER,
      verdict             TEXT NOT NULL,
      trust               TEXT NOT NULL,
      source_url          TEXT NOT NULL,
      source_domain_trust TEXT NOT NULL,
      confirmed_at        INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL,
      window_end          TEXT NOT NULL,
      pillar              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verdict_ledger_expires ON verdict_ledger(expires_at);
  `);
  stmts = {
    get: db.prepare(`SELECT * FROM verdict_ledger WHERE ref = ?`),
    upsert: db.prepare(
      `INSERT OR REPLACE INTO verdict_ledger
         (ref, tmdb_id, verdict, trust, source_url, source_domain_trust, confirmed_at, expires_at, window_end, pillar)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    del: db.prepare(`DELETE FROM verdict_ledger WHERE ref = ?`),
    clear: db.prepare(`DELETE FROM verdict_ledger`),
  };
  return stmts;
}

/** The stored row for `ref`, or undefined. Freshness is NOT applied here — see classifyLedgerConsult. */
export function readVerdictRow(ref: string): VerdictRow | undefined {
  return getStmts().get.get(ref) as VerdictRow | undefined;
}

/**
 * Persist ONE confirm. Refuses anything qualifiesForLedger rejects and returns
 * false — the guard lives at the storage boundary, not only at the call site,
 * so no future caller can write a negative by forgetting to check.
 */
export function recordConfirm(input: {
  ref: string;
  tmdbId: number | undefined;
  review: WriteCandidate;
  windowEnd: string;
  pillar: string;
  now?: number;
}): boolean {
  if (!qualifiesForLedger(input.review)) return false;
  const now = input.now ?? Date.now();
  getStmts().upsert.run(
    input.ref,
    input.tmdbId ?? null,
    input.review.verdict,
    input.review.trust!,
    input.review.sourceUrl!,
    input.review.sourceDomainTrust ?? "unknown",
    now,
    now + verdictTtlMs(),
    input.windowEnd,
    input.pillar
  );
  return true;
}

/** Delete one row. Returns true if a row was actually removed. */
export function voidVerdictRow(ref: string): boolean {
  return getStmts().del.run(ref).changes > 0;
}

/**
 * TEST SEAM ONLY. Empties the table. Exported because the ledger is process-
 * global state reached through the shared connection, and a test file that
 * seeds a row must be able to hand the next case an empty ledger — otherwise
 * one case's confirm silently becomes the next case's hit.
 */
export function clearVerdictLedgerForTests(): void {
  getStmts().clear.run();
}
