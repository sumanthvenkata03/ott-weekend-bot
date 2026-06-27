// src/reconcile/ai-review.ts
// AI-REVIEW tier — an ADVISORY, search-grounded fact-check that runs AFTER
// reconcile has tiered the films and BEFORE the gate writes the review. It does
// the external check a human would (is the release real? does the date hold? is
// it the right film?) and ANNOTATES each 🟢/🟡 film with a verdict + source so
// the human's final review is a glance at a pre-flagged page.
//
// AUTHORITY BOUNDARY (Step 1): this changes NO tier and approves NOTHING. It
// attaches the advisory `aiReview` verdict, AND — for a SOURCED `reject` only —
// sets the actionable `aiDemoted` field, which removes the film from the
// renderable pool (the gate reads aiDemoted, not the verdict text). It only ever
// TIGHTENS: ✅ confirm / ⚠️ doubt / ❓ unverified / ⚠️ unavailable never demote,
// and nothing is ever promoted into render. The verdict TEXT stays outside the
// hash; `aiDemoted` is folded in (filmFingerprint), so the approved review and
// what renders stay identical.
//
// Budget + determinism: ONE batched callClaudeJSON-with-web-search per edition
// (≤2/drop), CACHED by (version + window + reviewed-film projection). It now runs
// BEFORE the gate, on BOTH the review run AND the --approve re-run — but the
// re-run is a cache HIT (no LLM call), so verdicts / demotion / hash reproduce
// exactly and the ≤2-call budget holds. FAIL SOFT toward MORE caution: any call
// error annotates every reviewed film "unavailable" ("verify manually") and
// demotes NOTHING (an infra failure is not a verdict).

import { z } from "zod";
import { createHash } from "node:crypto";
import { callClaudeJSON } from "../content/claude.js";
import { cached } from "../shared/cache.js";
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

export function buildReviewPrompt(edition: string, windowLabel: string, films: ReconciledFilm[]): string {
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

DATE RECENCY — when sources DISAGREE on the date, prefer the NEWER report, but ONLY when it is AUTHORITATIVE (bias toward KEEPING real films):
- Release dates are often announced months ahead and then changed, so a newer report can override older ones. BUT recency alone is NOT enough: weight RECENT + AUTHORITATIVE sources (official studio/distributor, trade press, CBFC, or the platform itself) over BOTH older announcements AND recent low-authority chatter (fan posts, rumor aggregators, unsourced "reportedly"). A recent RUMOR does NOT override an older OFFICIAL confirmation — when they conflict, that is "doubt", not "reject".
- Return "reject" on a date basis ONLY for a CONFIRMED negative from a recent authoritative source:
  (a) it gives a NEW release date you can place CLEARLY OUTSIDE ${windowLabel} — a concrete date after the window's end, NOT "TBA" / "delayed indefinitely" / a vague "early/mid/late <month>" that could still fall in the window; OR
  (b) the film ALREADY RELEASED on THIS pillar's own platform/region BEFORE this window. A prior THEATRICAL, festival, or other-region release does NOT disqualify a later OTT or wider release that lands in the window — that staggered in-window arrival is exactly what we want, so "confirm" (or "doubt") it, never "reject" on that basis.
- Everything short of that is "doubt", not "reject": a postponement with no concrete new date, an imprecise new date that might still fall in the window, two equally-recent sources that disagree, or a recent-but-unofficial claim against an official one. When unsure, prefer "doubt" — it keeps the film for the human to judge, whereas "reject" auto-removes it.

VERDICTS (exactly one per film):
- "confirm": search corroborates the release AND the date.
- "doubt": search found an UNRESOLVED reason for concern — a contested date where no source is clearly newer AND more authoritative, a postponement with no confirmed out-of-window date, an imprecise date that may still fall in the window, an open CBFC/legal issue, or a wrong-film risk. Cite the source.
- "reject": a recent AUTHORITATIVE source shows the release is NOT happening in this window — stalled, cancelled, a different film, a CONFIRMED new date clearly outside ${windowLabel}, or an earlier release on THIS pillar's own platform/region. Cite the recent source.
- "unverified": search returned nothing usable. reason = "couldn't confirm via search". NO sourceUrl.

FILMS (${edition} edition · window ${windowLabel}):
${filmsJson}

OUTPUT — STRICT JSON ONLY (no prose, no markdown). Exactly ONE entry per film above, keyed by its tmdbId:
{ "reviews": [ { "tmdbId": <number>, "verdict": "confirm|doubt|reject|unverified", "reason": "...", "sourceUrl": "https://..." } ] }`;
}

/**
 * Cache version for the RAW AI-review output ({reviews}). BUMP only when the
 * review PROMPT (buildReviewPrompt) or the AiReviewSchema SHAPE changes — a
 * cached blob would otherwise no longer mean what a fresh call produces. The
 * discipline-guard + auto-demote mapping run FRESH outside the cache, so changing
 * those needs NO bump. (Mirrors RESEARCH_CACHE_VERSION.)
 */
export const AI_REVIEW_CACHE_VERSION = "v1";

/** Verdicts are stable within a drop cycle; a same-day --approve must hit. */
const AI_REVIEW_CACHE_TTL_HOURS = 24;

/**
 * Stable cache key over the EXACT reviewer input (the projected 🟢/🟡 films) +
 * window + version. Identical input ⇒ identical cached verdicts ⇒ identical
 * demotion ⇒ identical gate hash (the --approve determinism spine). ANY data
 * change to a reviewable film changes the projection ⇒ new key ⇒ a fresh call
 * (and the gate hash changes too, correctly forcing a re-review).
 */
function reviewCacheKey(r: ReconcileResult, films: ReconciledFilm[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(films.map(projectForReview)))
    .digest("hex")
    .slice(0, 16);
  return `ai-review:${AI_REVIEW_CACHE_VERSION}:${r.pillar}:${r.window.start}-${r.window.end}:${digest}`;
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
    // CACHE the raw model output, keyed by the exact reviewer input. The review
    // run misses (one live web-search call); the --approve re-run hits (no call)
    // → identical verdicts → identical demotion → identical gate hash. The mapping
    // + demotion below run FRESH outside the cache (mirrors verdict-research).
    let miss = false;
    const out = await cached(
      reviewCacheKey(r, films),
      async () => { miss = true; return callClaudeJSON(prompt, AiReviewSchema, "opus", { webSearch: true }); },
      { ttlSeconds: AI_REVIEW_CACHE_TTL_HOURS * 3600 }
    );

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
        // downgrade to "unverified" so it never looks authoritative without a cite
        // (this is ALSO what guarantees every actionable 🛑 carries a source).
        let review: AiReviewVerdict;
        if ((v.verdict === "doubt" || v.verdict === "reject") && !v.sourceUrl) {
          review = { verdict: "unverified", reason: `${v.reason} (no source cited)` };
        } else {
          review = v;
        }
        f.aiReview = review;
        // AUTO-DEMOTE (Step 1) — a SOURCED reject ONLY. Keyed on the VERDICT, not
        // the tier (a 🟡 film with a ✅ verdict is untouched). TIGHTENS ONLY: it
        // removes the film from renderable and moves the hash; it never promotes.
        if (review.verdict === "reject" && review.sourceUrl) {
          f.aiDemoted = {
            originalTier: f.tier,
            verdict: "reject",
            reason: review.reason,
            sourceUrl: review.sourceUrl,
          };
        }
        assessed++;
      } else {
        // Call succeeded but this film wasn't returned — never silently blank.
        f.aiReview = { verdict: "unverified", reason: "not returned by AI-review" };
      }
    }
    log.info(`AI-review [${r.pillar}]: ${assessed}/${films.length} films assessed via web search${miss ? "" : " (cache hit)"}`);
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
  log.info(`\n🔬 AI-review — fact-checking ${total} 🟢/🟡 film(s) via web search (sourced 🛑 → auto-removed; changes no tier)...`);
  await Promise.all(results.map((r) => reviewEdition(r)));
  return results;
}
