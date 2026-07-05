// src/content/weekend/verdict-select.ts
// Pure, deterministic Sat Verdict card selection — the JOB decides the count,
// not the LLM. Data-shape imports are type-only (erased under
// verbatimModuleSyntax); the only runtime import is the tiny console logger, so
// this module is still trivially unit-testable in isolation without pulling the
// job's heavy runtime deps (notion client, puppeteer, config).

import type { Release } from "../../shared/types.js";
import type { VerdictSlide } from "../../delivery/notion.js";
import type { VerdictResearch } from "./verdict-research.js";
import { log } from "../../shared/logger.js";

/** Soft ceiling on carousel cards. IG allows 20 slides incl. the cover; 10 keeps
 *  the carousel tight and avoids swipe fatigue. Only Skips overflow (see below). */
export const MAX_VERDICT_CARDS = 10;

export interface VerdictEntry {
  slide: VerdictSlide;
  // Explicit | undefined (not optional) so `.find()`'s result assigns cleanly
  // under exactOptionalPropertyTypes — a film may have no matching release.
  release: Release | undefined;
  /** Grounded research backing this entry (the slide also carries it). */
  research: VerdictResearch;
}

export function verdictKind(v: VerdictSlide["verdict"]): "must-watch" | "worth-a-try" | "divisive" | "skip" {
  if (v.includes("Must Watch")) return "must-watch";
  if (v.includes("Worth a Try")) return "worth-a-try";
  if (v.includes("Divisive")) return "divisive";
  return "skip";
}

/** Buzz/notability-first importance, mirroring Wed Drop's tmdbPopularity sort,
 *  with quality (tbsiScore) and audience-size (imdbVotes) tie-breaks so equally
 *  buzzy films still order sensibly. A missing release scores 0 (sorts last). */
function importanceOf(r: Release | undefined): [number, number, number] {
  return [r?.tmdbPopularity ?? 0, r?.tbsiScore ?? 0, r?.imdbVotes ?? 0];
}

function compareImportanceDesc(a: VerdictEntry, b: VerdictEntry): number {
  const ai = importanceOf(a.release);
  const bi = importanceOf(b.release);
  return (bi[0] - ai[0]) || (bi[1] - ai[1]) || (bi[2] - ai[2]);
}

/**
 * Deterministic card selection — the JOB decides the count, not the LLM.
 *
 * Every judged film gets a card, ordered Must Watch → Worth a Try → Divisive →
 * Skip, each importance-desc. A soft ceiling of MAX_VERDICT_CARDS caps the carousel:
 *   - ≤ ceiling scored films → all carded, `trimmedSkips` empty (common case).
 *   - > ceiling → keep the first MAX_VERDICT_CARDS in the tier/importance order
 *     above; the overflow (which, because Skips sort last, is Skips) goes to
 *     `trimmedSkips`, feeding the cover's "ALSO SKIPPING" footer.
 *
 * INVARIANT: only ⏭️ Skip films may ever enter `trimmedSkips` — the footer is
 * literally labeled ALSO SKIPPING. Must Watch / Worth a Try are never trimmed:
 * if the non-Skip tiers ALONE exceed the ceiling, it yields (card them all) and
 * we log a warning rather than drop a positive verdict.
 *
 * Returns the cards in carousel order — hero first (top Must Watch, else top
 * Worth a Try, else top Skip) — plus the trimmed Skips (empty at ≤ ceiling).
 */
export function selectVerdictCards(
  entries: VerdictEntry[]
): { selected: VerdictEntry[]; trimmedSkips: VerdictEntry[] } {
  const must     = entries.filter(e => verdictKind(e.slide.verdict) === "must-watch").sort(compareImportanceDesc);
  const worth    = entries.filter(e => verdictKind(e.slide.verdict) === "worth-a-try").sort(compareImportanceDesc);
  const divisive = entries.filter(e => verdictKind(e.slide.verdict) === "divisive").sort(compareImportanceDesc);
  const skip     = entries.filter(e => verdictKind(e.slide.verdict) === "skip").sort(compareImportanceDesc);

  // Tier order: must-watch → worth-a-try → divisive → skip. Non-Skip tiers (now
  // including divisive) are NEVER trimmed — only Skips may overflow to ALSO SKIPPING.
  const nonSkip = [...must, ...worth, ...divisive];
  if (nonSkip.length > MAX_VERDICT_CARDS) {
    log.warn(
      `Sat Verdict: ${nonSkip.length} non-Skip (Must Watch / Worth a Try / Divisive) films exceed the ` +
      `${MAX_VERDICT_CARDS}-card ceiling — carding all (ceiling yields; non-Skip verdicts are never trimmed).`
    );
  }

  // Card all non-Skip, then fill remaining slots with the most-notable Skips;
  // the rest overflow. Math.max(0, …) keeps skipSlots at 0 when non-Skip alone
  // already meets or exceeds the ceiling.
  const skipSlots = Math.max(0, MAX_VERDICT_CARDS - nonSkip.length);
  return { selected: [...nonSkip, ...skip.slice(0, skipSlots)], trimmedSkips: skip.slice(skipSlots) };
}
