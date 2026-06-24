// src/reconcile/select.ts
// Pre-LLM pool bound for the Wed Drop selector. PURE — imports only the Release
// type, so it's unit-testable with no I/O (and can't be pulled into a test via
// the self-executing jobs/wednesday-drop.ts).
//
// The problem this fixes: AI-net-discovered films are built without
// tmdbPopularity, so a plain popularity-desc slice(0, 40) sinks them to the
// bottom and amputates them BEFORE the LLM selector ever sees them. The LLM —
// not the cap — is the editorial filter (it picks <=15 or skips), so a film cut
// here is a film the LLM can neither pick nor reject.
//
// Fix: AI finds are CAP-EXEMPT — they always survive into the selector input.
// The popularity slice applies ONLY to the TMDb-pool portion, sized to fill the
// remaining budget. A safety ceiling on AI finds keeps a pathological window
// from unbounding the input (and is logged loudly, never silent).
import type { Release } from "../shared/types.js";
import { log } from "../shared/logger.js";

/** Total films fed to the LLM selector on a normal window. */
export const SELECTOR_POOL_TARGET = 40;
/** Hard ceiling on AI finds, mirroring the discovery engine's HARD_PAGE_CEILING. */
export const AI_FIND_CEILING = 40;

/** An AI-net-discovered Release carries "ai-net" in its sources provenance. */
function isAiFind(r: Release): boolean {
  return r.sources.includes("ai-net");
}

function byPopularityDesc(a: Release, b: Release): number {
  return (b.tmdbPopularity ?? 0) - (a.tmdbPopularity ?? 0);
}

/**
 * Bound the candidate pool fed to the LLM selector while guaranteeing every
 * AI-net find reaches it:
 *   - AI finds: kept in full, EXEMPT from the popularity slice (they have no
 *     tmdbPopularity and must not be ranked out). Capped only by AI_FIND_CEILING
 *     as a pathological-window safety floor — exceeding it is logged loudly.
 *   - TMDb-pool films: popularity-desc, sliced to fill the remaining budget
 *     (poolTarget - keptAiFinds). The slice still works for pool films — a
 *     low-popularity pool film is still cut when the pool exceeds its slice.
 *
 * This does NOT bypass the LLM: it only controls what reaches the selector's
 * input. The LLM still picks <=15 or skips, and an AI find can still be passed
 * over. (🔴 films are already gate-excluded upstream and never reach here.)
 */
export function capPoolForSelector(deduped: Release[], poolTarget = SELECTOR_POOL_TARGET): Release[] {
  const aiFinds = deduped.filter(isAiFind);
  const poolFilms = deduped.filter(r => !isAiFind(r));

  // AI finds keep ALL, up to the safety ceiling. Current windows yield 0-1 AI
  // finds, so this never fires today — but it must never be silent if it does.
  let keptAiFinds = aiFinds;
  if (aiFinds.length > AI_FIND_CEILING) {
    keptAiFinds = [...aiFinds].sort(byPopularityDesc).slice(0, AI_FIND_CEILING);
    log.warn(
      `reconcile selector: ${aiFinds.length} ai-net finds exceeded ceiling ${AI_FIND_CEILING}, ` +
      `kept top ${AI_FIND_CEILING} — pool fully evicted`
    );
  }

  const poolSlice = Math.max(0, poolTarget - keptAiFinds.length);
  const cappedPool = [...poolFilms].sort(byPopularityDesc).slice(0, poolSlice);

  return [...keptAiFinds, ...cappedPool];
}
