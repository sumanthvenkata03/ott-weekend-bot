// src/reconcile/merge-by-id.ts
// WD-ENG-20 — ONE TMDb ID IS ONE FILM.
//
// ── THE DEFECT (live in gate b35c32ce6447) ──────────────────────────────────
// Three pairs in the Aug-19 theatrical deck each shared ONE tmdbId and differed
// only in spelling or language variant, so every title-keyed dedupe upstream
// missed them and each film occupied TWO reconciled rows:
//
//   1685882  "Modha Rathri"    (tmdb+district)  vs "Modha Rathiri"   (wikipedia)
//   1036081  "Khalifa Part 1"  (tmdb)           vs "Khalifa"         (district)
//   1441228  "Irumudi" te      (tmdb+wiki+dist) vs "Irumudi Kattu" ta (district)
//
// ── WHERE THE PAIRS COME FROM ───────────────────────────────────────────────
// unionFilms already collapses by tmdbId (index.ts, second pass). It cannot
// help here, because at the moment it runs the second row HAS NO ID:
// resolveWikiOnlyFilms assigns tmdbId to wiki/district finds AFTER the union
// and nothing re-unions afterwards. Two DiscoveredFilms then carry the same id,
// both become stubs with the same `tmdb-<id>` Release id, both are enriched,
// and both arrive here as separate rows.
//
// ── WHY THE MERGE LIVES HERE AND NOT AT THE DISCOVERY UNION ─────────────────
// Re-unioning after resolveWikiOnlyFilms would collapse the rows one layer
// earlier — and would DESTROY the thing this merge is for. `audioLanguages` does
// not exist yet at that point: enrichWithCreditsAndLanguages builds it downstream
// from the surviving stub's own language (reconcileAudioOriginal). Collapsing
// there therefore throws the variant's language away before there is anywhere to
// put it, and "Irumudi Kattu" (Tamil) would vanish instead of becoming a Tamil
// pill on Irumudi's card. This seam is the first place where BOTH rows exist
// with their enriched records, their provenance and their tier inputs together.
//
// ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
//   · NOT a title-similarity merge. The ONLY key is a shared tmdbId. Two films
//     with confusable titles and different ids are still two films, and are
//     still handled by flagDuplicates — FLAG, never merge.
//   · NOT a path for TMDb-LESS rows. A row with no tmdbId is never grouped,
//     never rewritten and never dropped. That covers manual adds (`manual-` ids,
//     no tmdbId) and unverified ai-net leads. Both directions are pinned.
//   · NOT a weakening. The merged row unions provenance, so it can only ever
//     count MORE independent nets than either row it replaces.
import { log } from "../shared/logger.js";
import { discoveryTagsOf } from "./net-independence.js";
import type { ReconciledFilm } from "./types.js";

/** Strings that name the ABSENCE of a language — never a card pill. */
const NOT_A_LANGUAGE: ReadonlySet<string> = new Set(["", "Unknown", "Other"]);

/** One row that was folded into another, kept so the review can show it. */
export interface MergedVariant {
  title: string;
  language: string;
  foundIn: string[];
}

/** What one merge did — logged, and returned for the replay/audit. */
export interface MergeByIdReport {
  tmdbId: number;
  /** The row that survived, and whose title/language the deck now shows. */
  kept: string;
  keptLanguage: string;
  folded: MergedVariant[];
  /** The merged row's unioned provenance. */
  foundIn: string[];
  audioLanguages?: { original: string; dubbed?: string[] };
  /** Set when a folded row carried a date the kept row disagrees with. */
  dateConflict?: string;
}

/**
 * Did TMDb's OWN discover sweep surface this row?
 *
 * `Release.sources` is written by toReleaseStub from the DiscoveredFilm's
 * foundIn, so a "tmdb" tag there means the TMDb net found this film under this
 * title — i.e. the row's title and language ARE TMDb's own record. A wiki- or
 * district-resolved row carries only its own net's tag, however TMDb-backed it
 * later became. `discoveryTagsOf` is reused rather than a raw includes() so
 * enrichment tags (omdb / mdblist / tmdb-search) can never answer this question.
 */
export function isTmdbNetFind(f: ReconciledFilm): boolean {
  return discoveryTagsOf(f.release?.sources).includes("tmdb");
}

/**
 * Which row's title + language the merge keeps: TMDb's own record when one of
 * the rows is it, else the first row in deck order (deterministic, never
 * arbitrary). The canonical row is also the base for every other field, so the
 * merge can only ADD to a TMDb-authoritative record, never rewrite one.
 */
export function pickCanonical(group: readonly ReconciledFilm[]): ReconciledFilm {
  return group.find(isTmdbNetFind) ?? group[0]!;
}

/** Union preserving first-appearance order — canonical's tags stay in front. */
function union(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) for (const s of list) if (!out.includes(s)) out.push(s);
  return out;
}

/**
 * Fold every folded row's language into the kept row's audio track.
 *
 * The original NEVER changes — that is the kept row's, from TMDb's own record.
 * Each variant contributes its language, its own original, and its own dubbed
 * list, so a Tamil version folded into a Telugu record becomes a Tamil PILL
 * rather than a lost version. The two output rules match the existing
 * mergeAudioLanguages convention exactly: the original is never also a dub, and
 * English is dropped from the dub list unless it IS the original.
 *
 * Returns undefined when the kept row has no audio track at all — this never
 * fabricates one, and says so loudly, because a fabricated original is exactly
 * the field that would print a wrong language on a card.
 */
function foldAudio(
  canonical: ReconciledFilm,
  variants: readonly ReconciledFilm[]
): { original: string; dubbed?: string[] } | undefined {
  const base = canonical.release?.audioLanguages;
  if (!base) {
    const lost = variants.map((v) => v.language).filter((l) => !NOT_A_LANGUAGE.has(l));
    if (lost.length > 0) {
      log.warn(
        `  ⚠ merge-by-id: "${canonical.title}" (tmdb ${canonical.tmdbId}) has NO audioLanguages, so the ` +
          `folded version language(s) [${lost.join(", ")}] could not be added as pills. Nothing was ` +
          `fabricated — the card shows what the record actually carries.`
      );
    }
    return undefined;
  }

  const dubbed = new Set<string>(base.dubbed ?? []);
  for (const v of variants) {
    const from = [v.language, v.release?.audioLanguages?.original, ...(v.release?.audioLanguages?.dubbed ?? [])];
    for (const l of from) if (l && !NOT_A_LANGUAGE.has(l)) dubbed.add(l);
  }
  dubbed.delete(base.original);
  if (base.original !== "English") dubbed.delete("English");

  const list = [...dubbed].sort();
  return { original: base.original, ...(list.length > 0 ? { dubbed: list } : {}) };
}

function mergeGroup(
  tmdbId: number,
  group: readonly ReconciledFilm[]
): { film: ReconciledFilm; report: MergeByIdReport } {
  const canonical = pickCanonical(group);
  const variants = group.filter((f) => f !== canonical);

  const merged: ReconciledFilm = {
    ...canonical,
    // THE TIER INPUT. Union, canonical's tags first — so the merged row counts
    // every net that observed this film and can only be STRONGER than either
    // row it replaces. reconcile assigns the tier AFTER this runs.
    foundIn: union([canonical.foundIn, ...variants.map((v) => v.foundIn)]),
    reasons: [...canonical.reasons],
    mergedVariants: variants.map((v) => ({
      title: v.title,
      language: v.language,
      foundIn: [...v.foundIn],
    })),
  };

  // FILL-ABSENT ONLY. A merge must not lose a field the deck already had, and
  // must not overwrite the TMDb-authoritative record with a variant's value.
  //
  // `ambiguousMatch` is deliberately NOT carried across. It means "the title
  // lookup had several plausible hits" — a statement about one row's RESOLUTION,
  // not about the film. A shared tmdbId is the evidence that both rows resolved
  // to the same record, which settles that ambiguity rather than compounding it.
  // Anything about the FILM'S OWN FACTS — the dates below — does carry.
  for (const v of variants) {
    if (merged.platform === undefined && v.platform !== undefined) merged.platform = v.platform;
    if (merged.sourceUrl === undefined && v.sourceUrl !== undefined) merged.sourceUrl = v.sourceUrl;
    if (merged.posterUrl === undefined && v.posterUrl !== undefined) merged.posterUrl = v.posterUrl;
    if (merged.cast === undefined && v.cast !== undefined) merged.cast = [...v.cast];
    if (merged.year === undefined && v.year !== undefined) merged.year = v.year;
    if (merged.date === undefined && v.date !== undefined) {
      merged.date = v.date;
      merged.dateSource = v.dateSource;
    }
  }

  // A folded row that carried a DIFFERENT date is a real disagreement about the
  // film, and dropping it silently is the exact failure class WD-ENG-16B closed
  // at the other date seam. Surfaced as a conflictDetail, which assignTier reads
  // as `date-conflict` — so the merged row goes YELLOW and the review prints both
  // dates with the titles they came from. An existing conflictDetail is never
  // overwritten.
  const differing = variants.filter((v) => v.date !== undefined && merged.date !== undefined && v.date !== merged.date);
  let dateConflict: string | undefined;
  if (differing.length > 0) {
    dateConflict =
      `merged-variant dates: ${merged.date} ("${merged.title}") vs ` +
      differing.map((v) => `${v.date} ("${v.title}")`).join(" vs ");
    if (!merged.conflictDetail) merged.conflictDetail = dateConflict;
  }

  if (canonical.release) {
    merged.release = {
      ...canonical.release,
      sources: union([canonical.release.sources ?? [], ...variants.map((v) => v.release?.sources ?? [])]),
    };
    const audio = foldAudio(canonical, variants);
    if (audio) merged.release.audioLanguages = audio;
  }

  const report: MergeByIdReport = {
    tmdbId,
    kept: merged.title,
    keptLanguage: merged.language,
    folded: merged.mergedVariants!,
    foundIn: [...merged.foundIn],
    ...(merged.release?.audioLanguages ? { audioLanguages: merged.release.audioLanguages } : {}),
    ...(dateConflict ? { dateConflict } : {}),
  };
  return { film: merged, report };
}

/**
 * THE SEAM. Collapse rows that share a tmdbId into one row per film.
 *
 * Pure, order-stable, and additive-only in provenance. The merged row takes the
 * position of the group's FIRST row, so the deck order the operator reads does
 * not shuffle. Rows with no tmdbId, and ids carried by exactly one row, come
 * back untouched — the same objects, not copies.
 */
export function mergeByTmdbId(films: ReconciledFilm[]): {
  films: ReconciledFilm[];
  merges: MergeByIdReport[];
} {
  const groups = new Map<number, ReconciledFilm[]>();
  for (const f of films) {
    if (f.tmdbId === undefined) continue; // TMDb-less: never grouped, never touched
    const g = groups.get(f.tmdbId);
    if (g) g.push(f);
    else groups.set(f.tmdbId, [f]);
  }

  const mergedById = new Map<number, ReconciledFilm>();
  const merges: MergeByIdReport[] = [];
  for (const [tmdbId, group] of groups) {
    if (group.length < 2) continue;
    const { film, report } = mergeGroup(tmdbId, group);
    mergedById.set(tmdbId, film);
    merges.push(report);
  }
  if (mergedById.size === 0) return { films, merges };

  const emitted = new Set<number>();
  const out: ReconciledFilm[] = [];
  for (const f of films) {
    if (f.tmdbId === undefined) { out.push(f); continue; }
    const m = mergedById.get(f.tmdbId);
    if (!m) { out.push(f); continue; }
    if (emitted.has(f.tmdbId)) continue; // a folded row — its slot is gone
    emitted.add(f.tmdbId);
    out.push(m);
  }
  return { films: out, merges };
}

/** One audit line per merge. LOUD: rows leave the deck here. */
export function logMerges(pillar: string, merges: readonly MergeByIdReport[]): void {
  for (const m of merges) {
    log.warn(
      `  ⧉ merge-by-id [${pillar}] tmdb ${m.tmdbId}: kept "${m.kept}" (${m.keptLanguage}); folded ` +
        m.folded.map((v) => `"${v.title}" (${v.language}, ${v.foundIn.join("+")})`).join(", ") +
        ` → foundIn [${m.foundIn.join(", ")}]` +
        (m.audioLanguages?.dubbed ? `, audio ${m.audioLanguages.original} + [${m.audioLanguages.dubbed.join(", ")}]` : "") +
        (m.dateConflict ? ` — ⚠ ${m.dateConflict}` : "")
    );
  }
}
