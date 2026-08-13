// src/shared/post-validator.ts
// Landing verifier: proves every featured film belongs in the bucket it was
// placed in, by checking the date the CARD displays for that bucket against the
// bucket's window. Produces a human-readable manifest (the receipt), surfaces
// failures to the log + Slack, persists the manifest for zero-cost re-audit, and
// can optionally hard-fail before publish (HARD_FAIL_ON_INVALID).
//
// The check is about the DISPLAYED data: an arrival whose on-card OTT date falls
// outside the arrivals window fails — that is the user-visible "why is this here"
// mismatch, and the TMDb discover/detail drift that causes it.

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Release } from "./types.js";
import { hasRealVoteBase as voteBaseOf, awardsNumericSeal } from "./seal-decision.js";
import { missingPlatformLogos } from "./platform-logo.js";

export type Bucket = "arrival" | "gem" | "theatrical" | "ott" | "verdict" | "spotlight";
export type CheckStatus = "pass" | "fail" | "warn";

// Flip to true to make any failing landing ABORT the publish (throw). Default
// false — flag in log + Slack, let the human gate the draft.
export const HARD_FAIL_ON_INVALID = false;

// Theatre->OTT gap beyond this many days is surfaced as a soft warning.
const THEATRE_OTT_GAP_WARN_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

// THE VOTE-BASE STANDARD and THE SEAL DECISION now live in shared/seal-decision.ts
// so the renderer and this verifier share one implementation without an import
// cycle. Re-exported here because callers already import it from this module.
export { hasRealVoteBase } from "./seal-decision.js";

export interface BucketWindow {
  start: string;  // YYYY-MM-DD inclusive
  end: string;    // YYYY-MM-DD inclusive
  // which Release date qualifies this bucket:
  //  "ott" -> releaseDates.ott · "theatrical" -> releaseDates.theatrical
  //  "release" -> releaseDate (primary), with releaseDates.* as fallback
  dateField: "ott" | "theatrical" | "release";
  // if true, a film outside [start,end] is a WARN not a FAIL (e.g. Spotlight,
  // which may deliberately feature an older catalog gem).
  softWindow?: boolean;
  label: string;
}

export interface FilmInBucket {
  film: Release;
  bucket: Bucket;
  /** The card's WHY line (LLM slide body). Only the card contract reads it. */
  whyLine?: string;
}

// ── THE COMPLETENESS CONTRACT ────────────────────────────────────────────────
//
// The landing verifier above answers "does this film BELONG here". The contract
// answers "will its CARD be complete" — every slot the template needs, present
// before we render, so a card can never ship with a missing band again.
//
// OPT-IN by card type. Existing callers (Sat Verdict, Mon Movement, Sun
// Spotlight) pass nothing and are byte-for-byte unaffected; only a caller that
// names a cardType gets the extra checks. That is what lets this land without
// touching four other pillars' behaviour.
//
// SEVERITY follows the ruling, not intuition:
//   - a missing POSTER is a WARN (R5): the typographic fallback is a DESIGNED
//     state, and blocking on it would eat real films for a TMDb art gap.
//   - a missing BAND is a FAIL: the card renders visibly incomplete.
//   - a missing CAST line is a WARN: Line 2 is optional by design.
// Every check names itself in the row it fails, so a red ping can quote it.

export type CardType = "wed-drop";

export interface ContractOptions {
  /** Which card template these films will render into. Omit ⇒ no card checks. */
  cardType?: CardType;
  /**
   * The edition's IST date. A qualifying date AFTER this is a PRE-RELEASE film,
   * which may not show a numeric score (R7 — the Jana Nayagan case).
   */
  editionDate?: string;
  /** Below this many characters a synopsis cannot ground a why-line (R4). */
  minSynopsisChars?: number;
}

/** R4 — a synopsis shorter than this cannot ground an editorial why-line. */
export const MIN_SYNOPSIS_CHARS = 80;

export interface ManifestRow {
  title: string;
  id: string;
  bucket: Bucket;
  qualifyingDate: string | null;
  dateField: string;
  window: string;
  status: CheckStatus;
  reason: string;
}

export interface PostManifest {
  pillar: string;
  issue: string;
  builtAt: string;
  /**
   * Provenance (the working-tree law — see shared/run-context.ts). Jobs run the
   * WORKING TREE, so a manifest without these cannot be traced to code.
   */
  headSha?: string;
  treeDirty?: boolean | null;
  rows: ManifestRow[];
  passCount: number;
  warnCount: number;
  failCount: number;
  ok: boolean;
}

// YYYY-MM-DD compares correctly as a string.
export function inWindow(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

// Resolve the date that qualifies a film for a bucket, plus a field label.
export function qualifyingDate(
  film: Release,
  field: BucketWindow["dateField"]
): { date: string | null; label: string } {
  if (field === "ott") return { date: film.releaseDates?.ott ?? null, label: "OTT" };
  if (field === "theatrical") return { date: film.releaseDates?.theatrical ?? null, label: "theatrical" };
  const d = film.releaseDate ?? film.releaseDates?.theatrical ?? film.releaseDates?.ott ?? null;
  return { date: d, label: "release" };
}

// Build the manifest for a published post. No I/O.
export interface ManifestMeta {
  headSha?: string;
  treeDirty?: boolean | null;
}

export function buildManifest(
  pillar: string,
  issue: string,
  films: FilmInBucket[],
  windows: Partial<Record<Bucket, BucketWindow>>,
  meta: ManifestMeta = {},
  contract: ContractOptions = {}
): PostManifest {
  const idCounts = new Map<string, number>();
  for (const { film } of films) idCounts.set(film.id, (idCounts.get(film.id) ?? 0) + 1);

  const rows: ManifestRow[] = films.map(({ film, bucket, whyLine }) => {
    const win = windows[bucket];
    const reasons: string[] = [];
    let status: CheckStatus = "pass";
    const fail = (r: string) => { reasons.push(r); status = "fail"; };
    const warn = (r: string) => { reasons.push(r); if (status !== "fail") status = "warn"; };
    // INFO — recorded in `reason` for the receipt, but never moves `status`. For
    // things the operator should be able to see happened, that are not problems.
    const info = (r: string) => { reasons.push(r); };

    if (!win) {
      fail(`no window configured for bucket "${bucket}"`);
      return { title: film.title, id: film.id, bucket, qualifyingDate: null, dateField: "-", window: "-", status, reason: reasons.join("; ") };
    }

    const { date, label } = qualifyingDate(film, win.dateField);
    const windowStr = `${win.start} -> ${win.end}`;

    if (date === null) {
      (win.softWindow ? warn : fail)(`no ${label} date present to justify "${bucket}"`);
    } else if (!inWindow(date, win.start, win.end)) {
      (win.softWindow ? warn : fail)(`${label} ${date} outside ${windowStr}`);
    }

    if ((idCounts.get(film.id) ?? 0) > 1) fail(`film appears in multiple buckets`);

    if ((bucket === "arrival" || bucket === "ott") && film.platform.length === 0)
      warn(`OTT arrival with no known platform`);

    const th = film.releaseDates?.theatrical;
    const ot = film.releaseDates?.ott;
    if (th && ot) {
      const gap = (Date.parse(ot) - Date.parse(th)) / DAY;
      if (gap > THEATRE_OTT_GAP_WARN_DAYS) warn(`theatre->OTT gap ${Math.round(gap)}d`);
    }

    // ── SCORE HONESTY (WD-042 4a) — keyed to the RENDER, not to the data ──────
    // This used to test "does the record carry a score", which is not what the
    // reader sees. Issue 041 failed Cocktail 2, Bharat Bhhagya Viddhaata and
    // Heartin for a vote-base problem their cards had already handled correctly
    // by printing NEW. The verifier was calling the renderer a liar for telling
    // the truth.
    //
    // It now asks the same question the seal asks (awardsNumericSeal, shared with
    // buildStampContext):
    //   data-score + NEW stamp  → PASS, with an info note that it was withheld
    //   an actual numeric seal without a vote base → FAIL
    // That second branch is now UNREACHABLE — buildStampContext refuses the seal
    // (WD-041-FIX-A) — and it is kept deliberately, as a tripwire: if anyone ever
    // loosens the seal branch, the manifest fails loudly instead of silently
    // shipping an unearned number.
    const hasScore = typeof film.imdbRating === "number" || typeof film.tbsiScore === "number";
    const showsNumber = awardsNumericSeal(film);
    if (showsNumber && !voteBaseOf(film)) {
      fail(`score shown with no real vote base`);
    } else if (hasScore && !showsNumber) {
      info(`score withheld — no vote base; card shows the NEW stamp`);
    }

    // ── COMPLETENESS CONTRACT (opt-in per card type) ────────────────────────
    if (contract.cardType === "wed-drop") {
      // POSTER — warn only (R5). The typographic fallback is a designed state.
      if (!film.posterUrl) warn(`contract:poster — no poster art; card ships the typographic fallback`);

      // PLATFORM LOGO — warn only (WD-042 5a). The card degrades to a text-only
      // "NOW ON <PLATFORM>" header, which is honest; this exists so a missing
      // mark is VISIBLE in the receipt instead of being discovered on a
      // published card as an empty white box.
      for (const stem of missingPlatformLogos(film.platform)) {
        warn(`platform-logo-missing: ${stem} — card ships the text-only platform line`);
      }

      // BAND: ★ RELEASED. Mirrors hasReleasedSection() exactly.
      if (!film.releaseDates?.theatrical && !film.releaseDates?.ott) {
        fail(`contract:band-released — no releaseDates.{theatrical,ott}; the ★ RELEASED band would not render`);
      }

      // BAND: ★ AVAILABLE IN. Mirrors hasLanguagesSection() exactly. This is the
      // check that would have caught the Ottam Thullal card.
      if (!film.audioLanguages?.original) {
        fail(`contract:band-available-in — no audioLanguages.original; the ★ AVAILABLE IN band would not render`);
      }

      // R2 — the date is real but its provenance is the discover row, not an IN
      // release_dates entry. Named so a reviewer can see WHY the date is trusted.
      if (film.releaseDatesFallback === "discover") {
        warn(`contract:date-provenance — date: discover-fallback (TMDb had no IN release_dates row)`);
      }

      // CAST — warn (Line 2 drops by design when neither cast nor music exists).
      const hasCast = (film.leadCast?.length ?? 0) > 0 || film.cast.length > 0;
      if (!hasCast) warn(`contract:cast — no cast; the "with …" line will not render`);

      // WHY-LINE presence. The card's whole editorial payload.
      if (whyLine !== undefined && whyLine.trim().length === 0) {
        fail(`contract:why-line — empty why-line; the card has no editorial copy`);
      }

      // WHY-LINE GROUNDING (R4). Too little synopsis to ground an editorial
      // claim ⇒ the deterministic line must be used instead. This is what makes
      // "master plans backfire" a caught condition rather than a published one.
      if (whyLine !== undefined && whyLine.trim().length > 0) {
        const synopsis = (film.synopsis ?? "").trim();
        const floor = contract.minSynopsisChars ?? MIN_SYNOPSIS_CHARS;
        if (synopsis.length < floor) {
          warn(
            `contract:why-line-grounding — synopsis ${synopsis.length}c < ${floor}c; ` +
            `why-line must be the deterministic fallback, not an editorial claim`
          );
        }
      }

      // PRE-RELEASE SEAL (R7). A film whose qualifying date is still in the
      // future has no audience yet, so any fetched rating is noise — it must
      // carry the NEW stamp and no numeric seal, whatever TMDb returned.
      //
      // WD-042 4b — THE DOCUMENTED FALSE POSITIVE. "Pre-release" here means the
      // OTT date is still ahead, but an OTT arrival that already played cinemas
      // has a real audience and a legitimately earned score. Issue 041 failed
      // three such films (theatrical Jun 12 / Jun 19 / Jun 26, OTT Aug 14) as if
      // nobody had seen them. Skip when a PAST theatrical date exists; the check
      // now fires only for genuinely never-released films showing a number.
      //
      // DELIBERATELY still keyed to `hasScore`, NOT to awardsNumericSeal. R7's
      // founding fixture (Jana Nayagan: imdbRating 7.1, zero votes, opening
      // tomorrow) carries a score with no seal, and it must keep failing — the
      // suppression is about an unreleased film carrying a number AT ALL, which
      // is a stricter and separate question from which stamp gets drawn.
      const playedInCinemas =
        !!film.releaseDates?.theatrical &&
        !!contract.editionDate &&
        film.releaseDates.theatrical <= contract.editionDate;
      if (contract.editionDate && date !== null && date > contract.editionDate && hasScore && !playedInCinemas) {
        fail(
          `contract:pre-release-seal — ${label} ${date} is after the edition date ` +
          `${contract.editionDate}; a pre-release film may not show a numeric score`
        );
      }
    }

    return { title: film.title, id: film.id, bucket, qualifyingDate: date, dateField: label, window: windowStr, status, reason: reasons.join("; ") };
  });

  const passCount = rows.filter(r => r.status === "pass").length;
  const warnCount = rows.filter(r => r.status === "warn").length;
  const failCount = rows.filter(r => r.status === "fail").length;
  return {
    pillar, issue, builtAt: new Date().toISOString(),
    ...(meta.headSha !== undefined ? { headSha: meta.headSha } : {}),
    ...(meta.treeDirty !== undefined ? { treeDirty: meta.treeDirty } : {}),
    rows, passCount, warnCount, failCount, ok: failCount === 0,
  };
}

const ICON: Record<CheckStatus, string> = { pass: "OK", warn: "!", fail: "X" };

export function manifestToLog(m: PostManifest): string {
  const lines: string[] = [];
  lines.push(`Landing manifest - ${m.pillar} · Issue ${m.issue} - ${m.passCount} pass / ${m.warnCount} warn / ${m.failCount} fail`);
  for (const r of m.rows) {
    const head = `  [${ICON[r.status]}] ${r.title.slice(0, 30).padEnd(30)} ${r.bucket.padEnd(11)} ${r.dateField} ${r.qualifyingDate ?? "-"}  in ${r.window}`;
    lines.push(head + (r.reason ? `\n        -> ${r.reason}` : ""));
  }
  return lines.join("\n");
}

export function manifestToSlack(m: PostManifest): { metaValue: string; issuesBlock?: string } {
  const metaValue = m.ok
    ? `All ${m.passCount}/${m.rows.length} landings verified${m.warnCount ? ` · ${m.warnCount} warn` : ""}`
    : `${m.failCount} FAILED · ${m.warnCount} warn - review before posting`;
  const flagged = m.rows.filter(r => r.status !== "pass");
  if (flagged.length === 0) return { metaValue };
  const issuesBlock =
    `*Landing checks - ${m.failCount} fail / ${m.warnCount} warn*\n` +
    flagged.map(r => `${r.status === "fail" ? ":red_circle:" : ":large_yellow_circle:"} *${r.title}* (${r.bucket}) - ${r.reason}`).join("\n");
  return { metaValue, issuesBlock };
}

export function assertOrFlag(m: PostManifest): void {
  if (HARD_FAIL_ON_INVALID && !m.ok)
    throw new Error(`Post validation failed for ${m.pillar} Issue ${m.issue}: ${m.failCount} landing(s) outside window`);
}

/**
 * Thrown when a manifest with `ok: false` reaches the render gate (WD-042 4c).
 * Typed so the job can scope the block to ONE edition and still run the other,
 * while the process as a whole still ends nonzero.
 */
export class EditionBlockedError extends Error {
  constructor(readonly manifest: PostManifest) {
    super(
      `${manifest.pillar} Issue ${manifest.issue} BLOCKED — ${manifest.failCount} contract failure(s). ` +
      `Nothing rendered, nothing uploaded.`
    );
    this.name = "EditionBlockedError";
  }
}

/**
 * THE RENDER GATE (WD-042 4c). A manifest that is not ok stops its edition dead:
 * no PNGs, no R2, no Notion, no Slack draft. THERE IS NO BYPASS FLAG — the whole
 * point is that a contract failure cannot be waved through under deadline. To
 * publish anyway you must fix the data or pull the film (WED_DROP_EXCLUDE),
 * both of which leave a trace.
 *
 * Scope is ONE edition: a blocked theatrical run must not take a clean OTT run
 * down with it.
 */
export function assertRenderable(m: PostManifest): void {
  if (m.ok) return;
  throw new EditionBlockedError(m);
}

export function saveManifest(m: PostManifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf8");
}

export function loadManifest(path: string): PostManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PostManifest;
}
