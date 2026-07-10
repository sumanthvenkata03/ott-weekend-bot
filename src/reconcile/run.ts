// src/reconcile/run.ts
// Edition-window + default-language helpers for the reconcile/verify layer. The
// live verification entry point (verifyCandidates) and its live TMDb deps moved
// to verify.ts (Step 4); this file keeps the Wed-edition window construction and
// the south-first default language set both of those consume.

import type { BucketWindow } from "../shared/post-validator.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";

/**
 * AI-net corroboration language set. Matches discovery's active finding set so
 * verify-corroborate stays aligned (find-N / verify-N). Cost is only more CACHED
 * Tavily queries — the LLM extraction stays ONE batched call per edition, so the
 * ≤2-call/drop budget is unchanged. Tier consequence: Marathi/Punjabi films can
 * reach 🟢 (cross-net corroborated) instead of being forced 🟡 (single-net).
 * Bengali was TRIMMED from active coverage (mirrors discovery's ALL_LANGUAGES).
 */
export const RECONCILE_LANGUAGES = ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Marathi", "Punjabi"];

/** Build the edition's landing window (hard window; ott vs theatrical dateField). */
export function editionWindow(
  pillar: WedDropEdition,
  start: string,
  end: string
): BucketWindow {
  return {
    start,
    end,
    dateField: pillar === "ott" ? "ott" : "theatrical",
    label: EDITION_META[pillar].notionTitle,
  };
}
