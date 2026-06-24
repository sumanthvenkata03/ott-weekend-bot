// src/reconcile/ai-review.ts
// AI-REVIEW tier — an ADVISORY, search-grounded fact-check that runs AFTER
// reconcile has tiered the films and BEFORE the gate writes the review. It does
// the external check a human would (is the release real? does the date hold? is
// it the right film?) and ANNOTATES each 🟢/🟡 film with a verdict + source so
// the human's final review is a glance at a pre-flagged page.
//
// AUTHORITY BOUNDARY (load-bearing): this changes NO tier, excludes NO film, and
// approves NOTHING. It only attaches `aiReview` to ReconciledFilm. The verdict is
// OUTSIDE the gate hash (it runs after decideGate). assignTier / decideGate /
// renderableFor never read it. The --approve flow is untouched.
//
// Budget: ONE batched callClaudeJSON-with-web-search per edition (≤2/drop). Runs
// on the review run only (the approve re-run skips this whole branch). FAIL SOFT
// toward MORE caution: any call error annotates every reviewed film "unavailable"
// ("verify manually"), never a silent blank and never a reassuring pass.

import { z } from "zod";
import { callClaudeJSON } from "../content/claude.js";
import { log } from "../shared/logger.js";
import type { AiReviewVerdict, ReconciledFilm, ReconcileResult } from "./types.js";

// The model returns these FOUR verdicts. "unavailable" is set only by fail-soft
// code here, never by the model.
const VerdictSchema = z.object({
  tmdbId: z.number(),
  verdict: z.enum(["confirm", "doubt", "reject", "unverified"]),
  reason: z.string(),
  sourceUrl: z.string().optional(),
});
const AiReviewSchema = z.object({
  reviews: z.array(VerdictSchema).default([]),
});

/** The 🟢/🟡 films an edition submits for review (🔴 is gate-excluded; skip it). */
function reviewableFilms(r: ReconcileResult): ReconciledFilm[] {
  return r.reconciled.filter((f) => f.tier === "green" || f.tier === "yellow");
}

/** Compact, fact-only projection of a film for the reviewer (no fabricated fields). */
function projectForReview(f: ReconciledFilm) {
  return {
    tmdbId: f.tmdbId,
    title: f.title,
    ...(f.resolvedTitle ? { resolvedTitle: f.resolvedTitle } : {}),
    ...(f.year !== undefined ? { year: f.year } : {}),
    language: f.language,
    ...(f.date ? { date: f.date } : {}),
    dateSource: f.dateSource,
    ...(f.platform ? { platform: f.platform } : {}),
    foundIn: f.foundIn,
    ...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {}),
  };
}

function buildReviewPrompt(edition: string, windowLabel: string, films: ReconciledFilm[]): string {
  const filmsJson = JSON.stringify(films.map(projectForReview), null, 2);
  return `You are a release fact-checker for The Big Screen Index. Using WEB SEARCH, you verify whether each film below is ACTUALLY releasing as claimed, in the stated window. You output DATA ONLY (strict JSON).

#1 RULE — BASE EVERY VERDICT ONLY ON WHAT WEB SEARCH RETURNS (most important):
- Use the WebSearch tool to check each film. Base your verdict ONLY on what you find in the search results — NOT on assumptions, memory, or the fact that the film was given to you.
- Cite a real sourceUrl (a URL you actually found in search) for every "doubt" and "reject", and for "confirm" where you can.
- If search cannot confirm the release, return verdict "unverified" with reason "couldn't confirm via search" and NO sourceUrl. NEVER invent, guess, or construct a URL.

YOU ASSESS ONLY — you do NOT rewrite anything:
- If a source shows a DIFFERENT date or cast, FLAG it in the reason (e.g. "source says August, not June — <url>"). Do NOT output a corrected date/cast/title. The film's data stays exactly as given to you.

FOR EACH FILM, check via search:
- Is this release actually CONFIRMED to happen in ${windowLabel}? (Official announcement / trade press / CBFC clearance — vs. stalled, postponed, cancelled, or "expected".)
- Does the DATE hold up? (Does the press corroborate the given date, or a different one?)
- Is this the RIGHT film? (Does the TMDb id / title / year match the film actually releasing — not a same-title different film?)

VERDICTS (exactly one per film):
- "confirm": search corroborates the release AND the date.
- "doubt": search found a REASON FOR CONCERN (postponed, contested/ wrong date, CBFC/legal issue, wrong-film risk). Cite the source.
- "reject": search shows the release is NOT happening as claimed (stalled, cancelled, or a different film). Cite the source.
- "unverified": search returned nothing usable. reason = "couldn't confirm via search". NO sourceUrl.

FILMS (${edition} edition · window ${windowLabel}):
${filmsJson}

OUTPUT — STRICT JSON ONLY (no prose, no markdown). Exactly ONE entry per film above, keyed by its tmdbId:
{ "reviews": [ { "tmdbId": <number>, "verdict": "confirm|doubt|reject|unverified", "reason": "...", "sourceUrl": "https://..." } ] }`;
}

/** Fail-soft annotation: every reviewed film gets "unavailable" → pushes the operator to look closer. */
function markUnavailable(films: ReconciledFilm[]): void {
  for (const f of films) {
    f.aiReview = { verdict: "unavailable", reason: "AI-review unavailable — verify manually" };
  }
}

/**
 * Review ONE edition's 🟢/🟡 films with a single web-search-grounded call, and
 * attach the verdicts. Never throws — on any failure the edition's films are
 * marked "unavailable".
 */
async function reviewEdition(r: ReconcileResult): Promise<void> {
  const films = reviewableFilms(r);
  if (films.length === 0) return;

  const windowLabel = `${r.window.start} → ${r.window.end}`;
  try {
    const prompt = buildReviewPrompt(r.pillar, windowLabel, films);
    const out = await callClaudeJSON(prompt, AiReviewSchema, "opus", { webSearch: true });

    const byId = new Map<number, AiReviewVerdict>();
    for (const v of out.reviews) {
      byId.set(v.tmdbId, {
        verdict: v.verdict,
        reason: v.reason,
        ...(v.sourceUrl ? { sourceUrl: v.sourceUrl } : {}),
      });
    }

    let assessed = 0;
    for (const f of films) {
      const v = f.tmdbId !== undefined ? byId.get(f.tmdbId) : undefined;
      if (v) {
        // Discipline guard: a doubt/reject with no source reads as a bare claim —
        // downgrade to "unverified" so it never looks authoritative without a cite.
        if ((v.verdict === "doubt" || v.verdict === "reject") && !v.sourceUrl) {
          f.aiReview = { verdict: "unverified", reason: `${v.reason} (no source cited)` };
        } else {
          f.aiReview = v;
        }
        assessed++;
      } else {
        // Call succeeded but this film wasn't returned — never silently blank.
        f.aiReview = { verdict: "unverified", reason: "not returned by AI-review" };
      }
    }
    log.info(`AI-review [${r.pillar}]: ${assessed}/${films.length} films assessed via web search`);
  } catch (err) {
    log.warn(`AI-review [${r.pillar}] failed — marking films unavailable`, err instanceof Error ? err.message : err);
    markUnavailable(films);
  }
}

/**
 * Annotate every edition's 🟢/🟡 films with an advisory AI-review verdict. Runs
 * the two editions in parallel (independent calls). Mutates the films in place
 * (attaching `aiReview`) and returns the same results array for chaining. Never
 * throws — the whole tier fails soft to "unavailable" so the review still writes.
 */
export async function annotateWithAiReview(results: ReconcileResult[]): Promise<ReconcileResult[]> {
  const total = results.reduce((n, r) => n + reviewableFilms(r).length, 0);
  if (total === 0) return results;
  log.info(`\n🔬 AI-review — fact-checking ${total} 🟢/🟡 film(s) via web search (advisory; changes no tier)...`);
  await Promise.all(results.map((r) => reviewEdition(r)));
  return results;
}
