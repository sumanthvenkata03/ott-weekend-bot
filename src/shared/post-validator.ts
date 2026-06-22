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

export type Bucket = "arrival" | "gem" | "theatrical" | "ott" | "verdict" | "spotlight";
export type CheckStatus = "pass" | "fail" | "warn";

// Flip to true to make any failing landing ABORT the publish (throw). Default
// false — flag in log + Slack, let the human gate the draft.
export const HARD_FAIL_ON_INVALID = false;

// Theatre->OTT gap beyond this many days is surfaced as a soft warning.
const THEATRE_OTT_GAP_WARN_DAYS = 365;
const DAY = 24 * 60 * 60 * 1000;

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

export interface FilmInBucket { film: Release; bucket: Bucket; }

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
export function buildManifest(
  pillar: string,
  issue: string,
  films: FilmInBucket[],
  windows: Partial<Record<Bucket, BucketWindow>>
): PostManifest {
  const idCounts = new Map<string, number>();
  for (const { film } of films) idCounts.set(film.id, (idCounts.get(film.id) ?? 0) + 1);

  const rows: ManifestRow[] = films.map(({ film, bucket }) => {
    const win = windows[bucket];
    const reasons: string[] = [];
    let status: CheckStatus = "pass";
    const fail = (r: string) => { reasons.push(r); status = "fail"; };
    const warn = (r: string) => { reasons.push(r); if (status !== "fail") status = "warn"; };

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

    const hasScore = typeof film.imdbRating === "number" || typeof film.tbsiScore === "number";
    const voteBase = (film.imdbVotes ?? 0) > 0 || (film.tmdbVoteCount ?? 0) >= 50;
    if (hasScore && !voteBase) warn(`score shown with no real vote base`);

    return { title: film.title, id: film.id, bucket, qualifyingDate: date, dateField: label, window: windowStr, status, reason: reasons.join("; ") };
  });

  const passCount = rows.filter(r => r.status === "pass").length;
  const warnCount = rows.filter(r => r.status === "warn").length;
  const failCount = rows.filter(r => r.status === "fail").length;
  return { pillar, issue, builtAt: new Date().toISOString(), rows, passCount, warnCount, failCount, ok: failCount === 0 };
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

export function saveManifest(m: PostManifest, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2), "utf8");
}

export function loadManifest(path: string): PostManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PostManifest;
}
