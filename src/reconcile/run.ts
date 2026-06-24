// src/reconcile/run.ts
// Edition-window + default-language helpers for the reconcile/verify layer. The
// live verification entry point (verifyCandidates) and its live TMDb deps moved
// to verify.ts (Step 4); this file keeps the Wed-edition window construction and
// the south-first default language set both of those consume.

import type { BucketWindow } from "../shared/post-validator.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";

/** South-first default language set (matches the discovery + content house style). */
export const RECONCILE_LANGUAGES = ["Telugu", "Tamil", "Malayalam", "Hindi", "Kannada"];

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
