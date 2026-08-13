// src/reconcile/platform-seam.ts
// WD-ENG-03 — SEAM #3: THE PLATFORM CONFIRMATION SEAM.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// AI-review confirmed, in writing, that two verified films had streaming homes:
//
//   Kattalan      "Trade press confirms Kattalan … streams on ManoramaMAX
//                  from August 13, 2026 — matches given date."
//   Aakhri Sawal  "Sanjay Dutt political drama Aakhri Sawal confirmed to
//                  premiere on Lionsgate Play August 14, 2026 …"
//
// The reconcile ENTRY carried that platform as a string (f.platform). The
// RELEASE record — release.platform, the field the no-platform demotion tests
// and the card actually renders — was still []. So enforcement asked "does this
// OTT film have a platform?", read the empty array, and demoted both films for
// having no platform confirmed by any net. The confirmation was sitting one
// field away the whole time.
//
// Both films needed WED_DROP_FORCE + WED_DROP_PLATFORM to publish. Two operator
// dials to restate something the pipeline had already established.
//
// reconcile/types.ts has been describing this gap by name since Phase 1 — see
// AiReviewVerdict.platformAgrees: "Absent when there is no existing platform to
// compare against (seam-#3 fills that case instead)."
//
// ── WHAT THIS SEAM IS NOT ───────────────────────────────────────────────────
// It is not a new source of truth and it does not relax a single check. It
// COPIES an existing, already-verified value across a field boundary:
//
//   fill ONLY when release.platform is empty   — JustWatch/TMDb always win
//   fill ONLY when the entry carries a string  — invents nothing
//   fill ONLY when the verdict is `confirm`    — doubt/reject/unverified fill nothing
//   fill ONLY exact Platform spellings         — an unknown token is skipped, loudly
//
// Zero valid tokens ⇒ no fill ⇒ the demotion fires exactly as it does today.
// That is deliberate: a platform that cannot render must not put a card out.
//
// ── ORDERING ────────────────────────────────────────────────────────────────
// Runs AFTER annotateWithAiReview (it reads the verdicts) and BEFORE
// enforceVerification (it must fill before the no-platform classification looks)
// and therefore before decideGate. Mutates in place, like enforceVerification.

import type { Platform } from "../shared/types.js";
import { asExactPlatform } from "../shared/platform.js";
import { log } from "../shared/logger.js";
import type { ReconciledFilm, ReconcileResult } from "./types.js";

/** One film's fill outcome. Returned pure so the caller owns all logging. */
export interface PlatformFill {
  title: string;
  /** The reconcile entry string the platforms were parsed out of. */
  from: string;
  /** Exact-spelling members written to release.platform, in source order. */
  platforms: Platform[];
  /** Tokens that are not Platform members — skipped, never coerced. */
  skipped: string[];
}

/**
 * Split a reconcile platform string into trimmed, non-empty tokens.
 * Comma-separated lists are the observed shape ("Prime Video, SimplySouth,
 * Lionsgate Play"). Nothing else is treated as a separator: a platform name may
 * legitimately contain spaces ("Lionsgate Play"), "+" ("Apple TV+") and "NXT".
 */
export function splitPlatformString(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * Is this film eligible for the seam? All four conditions, no exceptions.
 * Exported so the ordering/eligibility rules can be asserted directly.
 */
export function isSeamEligible(f: ReconciledFilm): boolean {
  return (
    !!f.release &&
    f.release.platform.length === 0 &&      // FILL-ONLY-WHEN-EMPTY (precedence)
    !!f.platform &&
    f.platform.trim().length > 0 &&
    f.aiReview?.verdict === "confirm"
  );
}

/**
 * Resolve one eligible film's platform string. PURE — no mutation, no logging.
 * Returns null when the film is not eligible or nothing valid was parsed, so
 * "no fill" and "fill with nothing" are the same observable state: untouched.
 */
export function resolvePlatformFill(f: ReconciledFilm): PlatformFill | null {
  if (!isSeamEligible(f)) return null;
  const raw = f.platform!;
  const platforms: Platform[] = [];
  const skipped: string[] = [];
  const seen = new Set<Platform>();
  for (const token of splitPlatformString(raw)) {
    const p = asExactPlatform(token);
    if (!p) { skipped.push(token); continue; }
    if (seen.has(p)) continue;              // "Netflix, Netflix" ⇒ one chip
    seen.add(p);
    platforms.push(p);
  }
  if (platforms.length === 0) return null;  // nothing renderable — demotion proceeds
  return { title: f.title, from: raw, platforms, skipped };
}

/**
 * Apply the seam across both editions, in place.
 *
 * IDEMPOTENT by construction: a filled film no longer has an empty
 * release.platform, so a second pass finds it ineligible and changes nothing.
 * That is what makes the review run and its --approve re-run agree.
 *
 * Returns every fill performed, for the caller's audit.
 */
export function fillConfirmedPlatforms(results: ReconcileResult[]): PlatformFill[] {
  const fills: PlatformFill[] = [];
  for (const r of results) {
    for (const f of r.reconciled) {
      const fill = resolvePlatformFill(f);
      if (!fill) continue;
      f.release!.platform = fill.platforms;
      // Recorded on the film so the GATE REVIEW can show the operator what will
      // actually render — not the raw string it was parsed from.
      f.platformFilled = { from: fill.from, platforms: [...fill.platforms], skipped: [...fill.skipped] };
      fills.push(fill);
      log.info(`  [platform-seam] ${f.title}: AI-review-confirmed → ${fill.platforms.join(", ")}`);
      if (fill.skipped.length > 0) {
        log.warn(
          `  ⚠ [platform-seam] ${f.title}: skipped unrecognised platform token(s) ` +
          `${fill.skipped.map((s) => `"${s}"`).join(", ")} — not in the Platform union, ` +
          `so no logo could render. Filled ${fill.platforms.join(", ")} only.`
        );
      }
    }
  }
  return fills;
}
