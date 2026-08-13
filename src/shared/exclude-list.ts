// src/shared/exclude-list.ts
// Manual one-off exclusion hook, shared by the pillar jobs.
//
// Both functions below were extracted VERBATIM from wednesday-drop.ts (where
// they shipped first) so Sat Verdict reuses the exact same token grammar rather
// than growing a second, subtly-different parser. Wednesday's behaviour is
// unchanged by the move — it now imports what it used to declare.
//
// TOKEN GRAMMAR (one comma-separated list per pillar env var):
//   - a token that is an exact integer  → TMDb id match   (the reliable key)
//   - anything else                     → lowercased exact-title match
// Prefer the TMDb id ALWAYS: titles collide across languages and get rewritten
// upstream between runs; ids do not.
//
// Env vars using this grammar:
//   WED_DROP_EXCLUDE     — Wed Drop, applied POST-GATE inside produceEdition
//                          (hash-neutral; the --approve token stays valid)
//   SAT_VERDICT_EXCLUDE  — Sat Verdict, applied PRE-RESEARCH right after
//                          ingestReleases, so an excluded film never consumes a
//                          billed deep-research slot. See saturday-verdict.ts.

import type { Release } from "./types.js";

export function parseExcludeList(raw: string | undefined): { ids: Set<number>; titles: Set<string> } {
  const ids = new Set<number>();
  const titles = new Set<string>();
  for (const tok of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const n = Number(tok);
    if (Number.isInteger(n) && String(n) === tok) ids.add(n);
    else titles.add(tok.toLowerCase());
  }
  return { ids, titles };
}

export function isManuallyExcluded(r: Release, ex: { ids: Set<number>; titles: Set<string> }): boolean {
  if (r.tmdbId !== undefined && ex.ids.has(r.tmdbId)) return true;
  return ex.titles.has(r.title.trim().toLowerCase());
}
