// src/reconcile/verify.ts
// The SHARED verification surface. ANY pillar calls verifyCandidates(...) after
// getCandidates and before its own selection, to get a tiered (+ optionally
// AI-reviewed) ReconcileResult. It COMPOSES the existing pure pieces — the AI net
// (runAiNet), the reconcile core (resolve / tier / assessDates / reject buckets /
// dup-flag / pool join), and the advisory AI-review — without reimplementing any
// of them.
//
// The GATE is a SEPARATE, opt-in step (gate.ts: decideGate + writeReview), NOT
// folded in here, because it hashes across a SET of results (Wednesday's two
// editions) — a one-film pillar can take verification without a deck-shaped gate.

import { searchTitleTmdb, getCreditsAndLanguages } from "../ingestion/releases/tmdb.js";
import type { Release } from "../shared/types.js";
import type { BucketWindow } from "../shared/post-validator.js";
import { runAiNet } from "./ai-net.js";
import { reconcile, type ReconcileDeps } from "./reconcile.js";
import { annotateWithAiReview } from "./ai-review.js";
import type { ReconcileResult } from "./types.js";
import { RECONCILE_LANGUAGES } from "./run.js";

/** Live TMDb deps — cast comes from TMDb (leadCast), NEVER the LLM. (Was in run.ts.) */
export const liveDeps: ReconcileDeps = {
  searchTitle: (title, opts) => searchTitleTmdb(title, opts),
  fetchCredits: async (tmdbId) => {
    const { leadCast } = await getCreditsAndLanguages(tmdbId);
    return { leadCast };
  },
};

export interface VerifyOptions {
  /** Pillar LABEL (e.g. "theatrical", "ott"; later "sun-spotlight", …). */
  pillar: string;
  /** Landing window; window.dateField encodes intent ("ott" | "theatrical" | "release"). */
  window: BucketWindow;
  /** AI-net search languages (default: the south-first reconcile set). */
  languages?: string[];
  /**
   * Run the advisory AI-review fact-check. Default OFF — preserves Wednesday's
   * review-run-only, ≤2-call, outside-the-hash budget (Wednesday opts in via its
   * own explicit annotateWithAiReview call on the blocked run, not through here).
   */
  aiReview?: boolean;
  /** Pre-LLM corroboration cap. Default 40 (matches the prior reconcileEdition). */
  cap?: number;
  /** Injected TMDb access (default: live). */
  deps?: ReconcileDeps;
}

/**
 * Verify ONE candidate set: run the AI net, reconcile (resolve → tier →
 * assessDates → reject buckets → dup-flag → pool join), and OPTIONALLY annotate
 * with the advisory AI-review. Returns the SAME ReconcileResult shape pillars
 * already consume. No gate here — that's the separate opt-in step.
 *
 * This reproduces the prior run.ts `reconcileEdition` exactly when called with
 * the same (pillar, editionWindow, RECONCILE_LANGUAGES) — the basis for
 * Wednesday's zero-behavior-change refactor.
 */
export async function verifyCandidates(
  candidates: Release[],
  opts: VerifyOptions
): Promise<ReconcileResult> {
  const languages = opts.languages ?? RECONCILE_LANGUAGES;
  const deps = opts.deps ?? liveDeps;
  const cap = opts.cap ?? 40;

  const ai = await runAiNet(opts.pillar, languages, opts.window);
  const result = await reconcile(
    {
      pillar: opts.pillar,
      tmdbPool: candidates,
      aiFilms: ai.films,
      window: opts.window,
      cap,
      aiRejected: ai.rejected,
    },
    deps
  );

  if (opts.aiReview) await annotateWithAiReview([result]);
  return result;
}
