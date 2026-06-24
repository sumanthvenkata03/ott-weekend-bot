// src/reconcile/run.ts
// Edition-window + default-language helpers for the reconcile/verify layer. The
// live verification entry point (verifyCandidates) and its live TMDb deps moved
// to verify.ts (Step 4); this file keeps the Wed-edition window construction and
// the south-first default language set both of those consume.

import type { BucketWindow } from "../shared/post-validator.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";

/**
 * AI-net corroboration language set. Step 5a widened this to the FULL 8 supported
 * Indian languages so verify-corroborate matches discovery's finding set
 * (find-8 / verify-8). Cost is only more CACHED Tavily queries — the LLM
 * extraction stays ONE batched call per edition, so the ≤2-call/drop budget is
 * unchanged. Tier consequence: Bengali/Marathi/Punjabi films can now reach 🟢
 * (cross-net corroborated) instead of being forced 🟡 (single-net).
 */
export const RECONCILE_LANGUAGES = ["Telugu", "Tamil", "Malayalam", "Kannada", "Hindi", "Bengali", "Marathi", "Punjabi"];

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
