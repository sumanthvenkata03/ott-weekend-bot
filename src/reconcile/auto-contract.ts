// src/reconcile/auto-contract.ts
// WD-ENG-22B — THE AUTO-PUBLISH CONTRACT, ENUMERATED.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
// decideGate's auto branch was three booleans ANDed in an `if`:
//
//     if (!alwaysGate && !anyUncertain && everyEditionNonEmpty && everyRenderableGreen)
//
// which answers "may this ship?" and nothing else. When it says no — which,
// with WED_DROP_ALWAYS_GATE on, is every single run — the operator learns
// nothing about WHY, or about how close the drop came. Arming autonomy is a
// judgement call that needs exactly that evidence, week over week.
//
// So the predicate is re-expressed as an ENUMERATION: evaluateAutoContract
// walks every clause, collects EVERY failing one (never first-fail), and
// reports `wouldAuto` as "the blocker list is empty". decideGate consumes it.
//
// ── DECISION IDENTITY IS THE CONTRACT ───────────────────────────────────────
// For every input WITHOUT a verdict flip, `wouldAuto` is byte-for-byte the old
// three-clause expression. Enumerating more reasons must never change the
// ANSWER — a blocker that fires where the old expression passed would arm-by-
// accident, and one that stays silent where it failed would ship something the
// gate used to catch. auto-contract.test.ts pins both directions against a
// hand-written copy of the legacy predicate.
//
// The ONE deliberate difference is the FLIP CLAUSE (WD-ENG-22B part 2): a film
// whose fresh verdict disagrees with an expired ledger row blocks. That is new
// behaviour by design, and it ships dark — WED_DROP_ALWAYS_GATE defaults ON,
// and nothing in this packet arms anything.
//
// PURE. Reads films, returns a verdict. No clock, no env, no I/O, and it
// mutates nothing it is given.

import type { AutoBlocker } from "./autonomy.js";
import { isAutoPublishEligible } from "./net-independence.js";
import type { ReconcileResult, ReconciledFilm } from "./types.js";

export interface AutoContract {
  /** May this drop auto-publish? True iff `blockers` is empty. */
  wouldAuto: boolean;
  /** EVERY failing clause, not the first one. Empty ⇒ wouldAuto. */
  blockers: AutoBlocker[];
}

/**
 * A renderable film that counts as effective-green for AUTO-PUBLISH: a true
 * green that ALSO clears the narrow auto-publish bar, OR a single-net yellow
 * that enforcement PROMOTED (the web search corroborated it). A plain yellow is
 * not effective green — it forces the manual gate.
 *
 * ── WD-ENG-19 — WHY THE EXTRA CONJUNCT ─────────────────────────────────────
 * The TIER widened to count independent nets, so green now includes pairs like
 * tmdb+district. AUTO-PUBLISH did not widen: the operator's ruling was to
 * report evidence more honestly WITHOUT changing what ships with nobody
 * watching. So the gate asks BOTH questions, and they are deliberately
 * different:
 *
 *     f.tier === "green"          -> "how well evidenced is this film?"
 *     isAutoPublishEligible(...)  -> "may it ship unattended?"  (tmdb && ai-net)
 *
 * This keeps the auto-publish set BYTE-IDENTICAL to pre-WD-ENG-19: old-green
 * was (tmdb && ai-net) && no-other-issues, and tmdb+ai-net is always >=2
 * independent classes, so `new-green && isAutoPublishEligible` <=> old-green.
 *
 * DO NOT SIMPLIFY THIS BACK to `f.tier === "green"`. That would silently widen
 * auto-publish to every newly-green pair — the one thing WD-ENG-19 was told not
 * to do. A test pins that these are two distinct call sites.
 *
 * (WD-ENG-22B moved it here from gate.ts so the gate and the contract cannot
 * hold two copies of it. gate.ts imports it; the behaviour is unchanged.)
 */
export function isEffectiveGreen(f: ReconciledFilm): boolean {
  return (f.tier === "green" && isAutoPublishEligible(f.foundIn)) || !!f.aiPromoted;
}

/**
 * The films the auto-publish check looks at: everything with a Release that
 * enforcement did not remove and that is not hard-blocked red.
 *
 * Deliberately NOT deduplicated by release.id, because gate.ts's
 * `everyRenderableGreen` was not either — and for the EMPTINESS question dedup
 * cannot matter (a deduplicated list is empty exactly when the raw one is), so
 * this one helper faithfully serves both clauses.
 */
export function renderableFilms(r: ReconcileResult): ReconciledFilm[] {
  return r.reconciled.filter((f) => f.release && !f.aiDemoted && f.tier !== "red");
}

function blocker(title: string, check: string, recoverable: boolean): AutoBlocker {
  return { title, layer: "gate", check, recoverable };
}

/**
 * Which legs of the auto-publish bar this film is missing, named individually.
 *
 * "not promoted" appears on EVERY non-eligible film, and that is correct rather
 * than noise: isEffectiveGreen is a disjunction, so a film that fails it has
 * necessarily failed the promotion arm too. Naming it keeps the enumeration a
 * true account of the predicate instead of a summary of it.
 */
export function missingLegs(f: ReconciledFilm): string[] {
  const legs: string[] = [];
  if (f.tier !== "green") legs.push(`tier ${f.tier}`);
  if (!f.foundIn.includes("tmdb")) legs.push("no tmdb");
  if (!f.foundIn.includes("ai-net")) legs.push("no ai-net");
  if (!f.aiPromoted) legs.push("not promoted");
  return legs;
}

/** Is this film an operator manual-add? Mirrors reconcile.isManualAdd without importing it. */
function isOperatorAdd(f: ReconciledFilm): boolean {
  return f.manualAdd !== undefined && f.foundIn.length === 1 && f.foundIn[0] === "manual";
}

/**
 * THE CONTRACT. Every clause, every failure, named.
 *
 * Clause order is the reading order of a blocked run: what is structurally
 * missing (editions), then what is uncertain, then what is disputed (flips),
 * then film-by-film eligibility.
 */
export function evaluateAutoContract(results: readonly ReconcileResult[]): AutoContract {
  const blockers: AutoBlocker[] = [];

  // ── CLAUSE 0 — there must BE editions. gate.ts's `results.length > 0` guard;
  // an empty array would otherwise satisfy `.every(...)` vacuously and
  // auto-publish nothing at all.
  if (results.length === 0) {
    blockers.push(blocker("", "gate:no-editions — nothing to publish", false));
  }

  // ── CLAUSE 1 — every edition must have at least one renderable film. An
  // edition wiped to zero by enforcement is a human signal, never an
  // auto-publish.
  for (const r of results) {
    if (renderableFilms(r).length === 0) {
      blockers.push(blocker("", `gate:empty-edition — ${r.pillar} has no renderable film`, false));
    }
  }

  for (const r of results) {
    for (const f of r.reconciled) {
      // ── CLAUSE 2 — UNCERTAINTY. An "unavailable" verdict is an infra failure,
      // not a judgement: the review call died and NOTHING was assessed for this
      // film. It demotes nothing (so the film still renders) and it must not
      // ship unwatched. Note this clause reads EVERY reconciled film, including
      // red and demoted ones — exactly as gate.ts's anyUncertain did.
      if (f.aiReview?.verdict === "unavailable") {
        blockers.push(blocker(f.title, "gate:uncertain — AI-review unavailable (infra failure, nothing assessed)", true));
      }

      // ── CLAUSE 3 — THE FLIP CLAUSE (WD-ENG-22B). The film's fresh verdict
      // disagrees with a ledger row that had aged out. That is the week-to-week
      // instability WD-ENG-22A was built to make visible, and an unstable
      // verdict is precisely the thing that must not ship with nobody looking:
      // whichever of the two readings is right, the search is telling us it
      // cannot answer this film consistently.
      //
      // This is the ONE clause with no counterpart in the old predicate.
      const flip = f.verdictFlip;
      if (flip) {
        blockers.push(blocker(f.title, `gate:flip — ${flip.ref}: ${flip.previous} -> ${flip.current} (expired ledger row)`, false));
      }
    }

    // ── CLAUSE 4 — every renderable film must be effective-green.
    for (const f of renderableFilms(r)) {
      if (isEffectiveGreen(f)) continue;
      if (isOperatorAdd(f)) {
        // A manual add is reported as ITSELF rather than as a generic tier
        // miss. WD-ENG-11 fixed the dial at yellow and said outright that no
        // evidence basis promotes it, so "tier yellow, no tmdb, no ai-net" is
        // the DESIGN, not a data gap — labelling it as one would send an
        // operator hunting for a fetch that is never coming. Emitted INSTEAD of
        // the generic blocker below, so counts stay one-per-film.
        blockers.push(blocker(f.title, `gate:manual-add — operator assertion (${f.manualAdd!.label}); never auto-publishes`, false));
        continue;
      }
      // Recoverable only when the film is already green and merely lacks a net:
      // a later fetch can plausibly add tmdb or ai-net. A film that is not green
      // carries a real data problem (ambiguous match, duplicate, date conflict,
      // manifest warn) that needs judgement, not another run.
      blockers.push(blocker(f.title, `gate:not-effective-green — missing: ${missingLegs(f).join(", ")}`, f.tier === "green"));
    }
  }

  return { wouldAuto: blockers.length === 0, blockers };
}

// ── SHADOW AUTOPILOT rendering ──────────────────────────────────────────────
//
// OBSERVATION ONLY. These build strings. Nothing here reads or writes a
// decision, and no caller of decideGate changes behaviour because of them.

/** The one-line verdict, for the Slack ping and the Notion review header. */
export function shadowVerdictLine(contract: AutoContract): string {
  const n = contract.blockers.length;
  return `SHADOW AUTOPILOT: would auto-approve = ${contract.wouldAuto ? "YES" : "NO"}` +
    (n === 0 ? "" : ` (${n} blocker${n === 1 ? "" : "s"})`);
}

/**
 * The full greppable block for the run log: the verdict, then ONE line per
 * blocker. Every line carries the "SHADOW AUTOPILOT" prefix so a week of run
 * logs can be swept with a single grep.
 */
export function shadowAutopilotLines(contract: AutoContract): string[] {
  const lines = [shadowVerdictLine(contract)];
  for (const b of contract.blockers) {
    const who = b.title ? `${b.title} — ` : "";
    lines.push(`SHADOW AUTOPILOT:   ${who}${b.check} [${b.recoverable ? "may clear on re-run" : "needs a decision"}]`);
  }
  return lines;
}
