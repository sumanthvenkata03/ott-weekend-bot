// src/reconcile/run.ts
// Real-dependency wiring for one edition: AI net (Tavily + 1 LLM extraction) →
// reconcile (TMDb resolution via searchTitleTmdb + cast via getCreditsAndLanguages).
// reconcile.ts stays pure/injectable; this is where the live TMDb functions are
// bolted on. One LLM call per edition → two per drop (the locked budget).

import { searchTitleTmdb, getCreditsAndLanguages } from "../ingestion/releases/tmdb.js";
import type { Release } from "../shared/types.js";
import type { BucketWindow } from "../shared/post-validator.js";
import { EDITION_META, type WedDropEdition } from "../shared/wed-drop-edition.js";
import { runAiNet } from "./ai-net.js";
import { reconcile, type ReconcileDeps } from "./reconcile.js";
import type { ReconcileResult } from "./types.js";

/** South-first default language set (matches the discovery + content house style). */
export const RECONCILE_LANGUAGES = ["Telugu", "Tamil", "Malayalam", "Hindi", "Kannada"];

/** Live TMDb deps — cast comes from TMDb (leadCast), NEVER the LLM. */
const liveDeps: ReconcileDeps = {
  searchTitle: (title, opts) => searchTitleTmdb(title, opts),
  fetchCredits: async (tmdbId) => {
    const { leadCast } = await getCreditsAndLanguages(tmdbId);
    return { leadCast };
  },
};

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

/**
 * Augment one edition's TMDb pool with the AI-search net and reconcile into a
 * provenance-tagged, tiered list. Pure-logic core lives in reconcile.ts; this
 * wires the live AI net + TMDb resolution.
 */
export async function reconcileEdition(
  pillar: WedDropEdition,
  tmdbPool: Release[],
  start: string,
  end: string,
  languages: string[] = RECONCILE_LANGUAGES,
  deps: ReconcileDeps = liveDeps
): Promise<ReconcileResult> {
  const window = editionWindow(pillar, start, end);
  const ai = await runAiNet(pillar, languages, window);
  return reconcile(
    {
      pillar,
      tmdbPool,
      aiFilms: ai.films,
      window,
      cap: 40,
      aiRejected: ai.rejected,
    },
    deps
  );
}
