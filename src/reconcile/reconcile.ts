// src/reconcile/reconcile.ts
// PURE reconciliation core — no network, no LLM, no filesystem of its own. All
// TMDb access is injected (ReconcileDeps), so the whole join/flag/tier pipeline
// is unit-testable offline. The date-window check REUSES post-validator's pure
// primitives (qualifyingDate / inWindow) — it does NOT reimplement them.
//
// What it does, per the approved design:
//   - Resolve each AI-net film to a TMDb id via searchTitleTmdb; movie ⇒ attach
//     id + canonical title + poster + cast (cast from TMDb, NOT the LLM);
//     tv-only ⇒ reject as series; no match ⇒ "unverified" (title + source only).
//   - Indian-language guard (NEW ai-net films only): a freshly discovered film
//     whose resolved TMDb originalLanguage is NOT Indian is routed to rejected
//     ("non-Indian-language"), never emitted as a tiered film. Pool films
//     (foundIn includes "tmdb") are Indian by construction and are NEVER touched
//     by this guard.
//   - Join AI films to the TMDb pool by shared tmdbId ⇒ foundIn ["tmdb","ai-net"].
//   - Possible dupes (fuzzy title, no shared id, or two ids one title) ⇒ FLAG,
//     never merge.
//   - OTT press-date rescue: an AI OTT film whose TMDb ott date is blank but has
//     a sourced platform date is window-checked against the PRESS date and
//     tagged ott-date-from-press (the blind spot that made Blast get missed).
//   - Tier per §F. unverified is HARD-pinned 🔴 and renders no fabricated fields.
//
// AUGMENT-ONLY: every original TMDb candidate survives in `reconciled`; the AI
// net can only ADD films and annotate tier, never remove a TMDb candidate.

import type { Release } from "../shared/types.js";
import { toPlatform } from "../shared/platform.js";
import type { TmdbTitleHit, TmdbTitleSearch } from "../ingestion/releases/tmdb.js";
import { qualifyingDate, inWindow } from "../shared/post-validator.js";
import type { BucketWindow, ManifestRow } from "../shared/post-validator.js";
import { normalizeTitle } from "../discovery/normalize.js";
import { wikiLanguageFor } from "../discovery/sources/wikiLanguageIndex.js";
import { resolveTitleToTmdb, languageForCode, INDIAN_LANG_CODES } from "../discovery/sources/resolveTitle.js";
import { isIndianFilm, countryGateLine, type CountryFields } from "../shared/country-gate.js";
import { log } from "../shared/logger.js";
import type {
  ExtractedFilm,
  LandingStatus,
  ReconciledFilm,
  ReconcileResult,
  RejectedExtraction,
  Tier,
} from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// INDIAN_LANG_CODES + languageForCode (and the ±1yr resolve below) now live in
// the shared, pure discovery/sources/resolveTitle.ts — ONE implementation used by
// both this reconcile core and discovery's OTT search. Imported above.

// ── Injected TMDb access (real in run.ts, mocked in tests) ──────────────────
export interface ReconcileDeps {
  searchTitle: (title: string, opts: { year?: number; language?: string }) => Promise<TmdbTitleSearch>;
  /**
   * Top-billed cast for a movie id — TMDb, never the LLM.
   *
   * Also returns the raw country fields, because the live implementation already
   * calls /movie/{id} for the cast: seam (b) of the country gate therefore costs
   * ZERO additional API calls. `countries` is optional so existing test doubles
   * stay valid (an omitted value is the gate's fail-open ⚠ path).
   */
  fetchCredits: (tmdbId: number) => Promise<{ leadCast: string[]; countries?: CountryFields }>;
}

export interface ReconcileInput {
  pillar: string;
  tmdbPool: Release[];
  aiFilms: ExtractedFilm[];
  window: BucketWindow;
  /** Below this popularity rank, a corroborated pool film is tagged was-below-cap. */
  cap?: number;
  /** Optional pre-built landing manifest to fold in (else computed from `window`). */
  manifestRows?: ManifestRow[];
  /** Series / non-film items the LLM already rejected (surfaced in the review). */
  aiRejected?: RejectedExtraction[];
  /**
   * WD-ENG-06 — normalizedTitle → language, built from the Wikipedia list pages
   * the discovery run already fetched (buildWikiLanguageIndex). Consulted ONLY to
   * answer "is this film Indian" when TMDb.original_language says otherwise or
   * says nothing. Never overwrites a resolved language. Omit ⇒ the guard falls
   * back to the TMDb country evidence alone, which is today plus the fix.
   */
  wikiLanguageIndex?: ReadonlyMap<string, string>;
}

// ── Pure date helpers ───────────────────────────────────────────────────────

function validDates(...xs: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const x of xs) {
    if (typeof x === "string" && ISO.test(x) && !out.includes(x)) out.push(x);
  }
  return out;
}

function maxDayGap(dates: string[]): number {
  if (dates.length < 2) return 0;
  const ts = dates.map((d) => Date.parse(d)).sort((a, b) => a - b);
  return (ts[ts.length - 1]! - ts[0]!) / DAY;
}

/**
 * WD-ENG-16B — attach a provenance label to each date in the conflict detail.
 *
 * `all` is the SAME deduped array the conflict predicate ran on; this only
 * decorates it. A date that both nets report collapses to one entry in `all`, so
 * it is labelled with both sources rather than being silently attributed to one.
 */
function labelDates(
  all: string[],
  tmdbDate: string | null,
  aiDate: string | undefined,
  window: BucketWindow
): string {
  return all
    .map((d) => {
      const from: string[] = [];
      if (d === tmdbDate) from.push(`tmdb:${window.dateField}`);
      if (d === aiDate) from.push("press");
      // A date that appears only in datesSeen came from the press snippets too,
      // but was not the headline press date — say so rather than calling it TMDb.
      if (from.length === 0) from.push("press:seen");
      return `${d} (${from.join("+")})`;
    })
    .join(" vs ");
}

interface DateAssessment {
  landingStatus: LandingStatus;
  effective?: string;
  dateSource: "tmdb" | "press" | "none";
  ottDateFromPress: boolean;
  conflict: boolean;
  conflictDetail?: string;
  reason?: string;
}

/**
 * Decide the landing verdict + date provenance for a film, reusing qualifyingDate
 * / inWindow. A film PASSES if any known date lands in the window (this is the
 * press-date rescue — TMDb's blank ott date no longer fails an OTT film that the
 * press confirms in-window). Conflicts (dates >2d apart, or in/out-of-window
 * disagreement) are flagged separately so a conflicted-but-in-window film is 🟡,
 * not 🔴. `reason` carries the PRECISE landing explanation for the review.
 */
function assessDates(
  release: Release | null,
  // WD-ENG-16B — WIDENED to the structural subset this function actually reads.
  // ExtractedFilm still satisfies it, so every existing caller is unchanged; the
  // widening exists so the post-enrichment re-assessment can pass the two date
  // facts it has (from the ReconciledFilm) without fabricating a whole
  // ExtractedFilm just to satisfy a type.
  ai: { date?: string; datesSeen?: string[] } | undefined,
  window: BucketWindow
): DateAssessment {
  const tmdbDate = release ? qualifyingDate(release, window.dateField).date : null;
  const aiDate = ai?.date;
  const seen = ai?.datesSeen ?? [];
  const all = validDates(tmdbDate, aiDate, ...seen);

  const inWin = all.filter((d) => inWindow(d, window.start, window.end));
  const conflict =
    all.length >= 2 && (maxDayGap(all) > 2 || (inWin.length > 0 && inWin.length < all.length));

  // WD-ENG-16B — the detail now NAMES THE SOURCE of each date. The threshold and
  // the conflict predicate above are untouched; only the wording changes.
  // "dates seen: 2026-08-14 vs 2026-10-02" told an operator that two dates
  // existed but not which net believed which, so approving still meant guessing.
  // The review renders this string verbatim (gate.ts), so naming the sources
  // here is what puts BOTH dates AND their provenance in front of the operator
  // before they approve. Nothing here picks a winner.
  const conflictDetail = conflict ? `dates seen: ${labelDates(all, tmdbDate, aiDate, window)}` : undefined;

  // Effective date + its provenance: prefer the TMDb qualifying date; otherwise
  // fall back to the press date. For OTT specifically, a blank TMDb ott date +
  // a press date is the rescue path.
  let effective: string | undefined;
  let dateSource: "tmdb" | "press" | "none" = "none";
  let ottDateFromPress = false;
  if (tmdbDate && ISO.test(tmdbDate)) {
    effective = tmdbDate;
    dateSource = "tmdb";
  } else if (aiDate && ISO.test(aiDate)) {
    effective = aiDate;
    dateSource = "press";
    if (window.dateField === "ott") ottDateFromPress = true;
  } else if (inWin.length > 0) {
    effective = inWin[0];
    dateSource = "press";
  }

  let landingStatus: LandingStatus;
  let reason: string | undefined;
  if (all.length === 0) {
    landingStatus = window.softWindow ? "warn" : "fail";
    reason = "no qualifying date";
  } else if (inWin.length > 0) {
    landingStatus = "pass";
  } else {
    landingStatus = window.softWindow ? "warn" : "fail";
    reason = `date ${all.join(", ")} outside window ${window.start}..${window.end}`;
  }

  return {
    landingStatus,
    ...(effective ? { effective } : {}),
    dateSource,
    ottDateFromPress,
    conflict,
    ...(conflictDetail ? { conflictDetail } : {}),
    ...(reason ? { reason } : {}),
  };
}

/**
 * WD-ENG-16B — RE-RUN THE LANDING/CONFLICT ASSESSMENT ONCE THE RECORD IS WHOLE.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * assessDates is correct and has always been correct. On the AI-net-only path it
 * was simply CALLED TOO EARLY: buildFromNewAi invokes it as
 * `assessDates(null, ai, window)` — release is null — so `all` holds exactly one
 * date and there is nothing to conflict with. The TMDb date arrives afterwards,
 * when enrichAiNetFilms replaces f.release with the enriched record and
 * mergeReleaseDates prefers TMDb's releaseDates.theatrical over the press one.
 *
 * Shabara: admitted on press 2026-08-14, enriched to TMDb 2026-10-02, tiered
 * yellow/"single-net" with no date-conflict, because the tier was decided before
 * the second date existed. The manifest caught it later and blocked the render —
 * but only after the operator had already approved a review showing ONE date.
 *
 * The fix is ordering, not a new rule: no second conflict definition, the 2-day
 * threshold untouched, mergeReleaseDates precedence untouched. The existing
 * check is simply asked the question again once both dates are present.
 *
 * WARN, NOT FAIL, deliberately. A conflict makes the film yellow and puts both
 * dates in the review; it does not block. The genuinely dangerous case — a
 * PRINTED date outside the window — is already a hard block at the manifest
 * (assertRenderable), and that is the right place for it. Blocking an edition on
 * a 7-day disagreement, which in this data is usually a real preponement rather
 * than an error, would cost more than it saves.
 *
 * Mutates in place and returns whether anything changed, so the caller can log
 * the movement rather than silently re-tiering films behind the operator.
 */
export function reassessAfterEnrichment(
  f: ReconciledFilm,
  window: BucketWindow
): { changed: boolean; before: { tier: Tier; landingStatus?: LandingStatus } } {
  const before = { tier: f.tier, ...(f.landingStatus ? { landingStatus: f.landingStatus } : {}) };

  // The film's own press date is the AI half; the enriched release is the TMDb
  // half. `datesSeen` is not retained on ReconciledFilm, so the re-assessment
  // sees the two headline dates — which is exactly the pair that diverged.
  const da = assessDates(f.release ?? null, { ...(f.date ? { date: f.date } : {}) }, window);

  f.landingStatus = da.landingStatus;
  if (da.reason) f.landingReason = da.reason;
  else delete f.landingReason;
  if (da.conflictDetail) f.conflictDetail = da.conflictDetail;
  else delete f.conflictDetail;

  const t = assignTier(f);
  f.tier = t.tier;
  f.reasons = t.reasons;

  const changed = before.tier !== f.tier || before.landingStatus !== f.landingStatus;
  return { changed, before };
}

// ── Tiering (§F) ────────────────────────────────────────────────────────────

/**
 * Pure tier decision. RED: unverified / series / manifest fail. GREEN: confirmed
 * movie + window pass + found in BOTH nets + zero issues. Otherwise YELLOW with
 * the specific issue(s). The date-fail reason comes straight from assessDates
 * (landingReason) — no hand-reworded "outside window".
 */
export function assignTier(f: ReconciledFilm): { tier: Tier; reasons: string[] } {
  if (f.status === "unverified")
    return { tier: "red", reasons: ["unverified — no TMDb match; title + source only"] };
  if (f.status === "series-rejected")
    return { tier: "red", reasons: ["series / show — rejected"] };
  if (f.landingStatus === "fail")
    return { tier: "red", reasons: [`manifest fail — ${f.landingReason ?? f.conflictDetail ?? "date check"}`] };

  const issues: string[] = [];
  if (!(f.foundIn.includes("tmdb") && f.foundIn.includes("ai-net"))) issues.push("single-net");
  if (f.landingStatus === "warn") issues.push(`manifest warn${f.landingReason ? ` — ${f.landingReason}` : ""}`);
  if (f.conflictDetail) issues.push("date-conflict");
  if (f.possibleDuplicate) issues.push("possible-duplicate");
  if (f.ambiguousMatch) issues.push("ambiguous TMDb match");

  if (issues.length === 0) return { tier: "green", reasons: ["TMDb-confirmed · window pass · ≥2 nets agree"] };
  return { tier: "yellow", reasons: issues };
}

// ── AI-film resolution (the only async part — injected deps) ────────────────

interface AiResolution {
  ai: ExtractedFilm;
  kind: "movie" | "series" | "unverified";
  hit?: TmdbTitleHit;
  ambiguous: boolean;
  cast?: string[];   // fetched only for NEW (non-pool) movie hits
  /** Country fields from the SAME fetchCredits call — country gate, seam (b). */
  countries?: CountryFields;
}

async function resolveAiFilm(
  ai: ExtractedFilm,
  deps: ReconcileDeps,
  windowYear: number,
  poolByTmdbId: Map<number, Release>
): Promise<AiResolution> {
  // The LLM's own series flag is authoritative-to-reject (belt; resolveTitleToTmdb
  // short-circuits on it) — and /search/tv is the suspenders. Skip the TMDb call
  // entirely for a flagged series (no wasted search).
  const search = ai.isSeries
    ? { movie: [], tv: [] }
    : await deps.searchTitle(ai.title, {
        year: windowYear,
        ...(ai.language ? { language: ai.language } : {}),
      });

  // SHARED resolve — the ±1yr "2019 Blast trap" guard + language narrowing live
  // in ONE place (discovery/sources/resolveTitle.ts), used here AND by discovery's
  // OTT search. No duplicated logic.
  const res = resolveTitleToTmdb(
    { title: ai.title, isSeries: ai.isSeries, ...(ai.language ? { language: ai.language } : {}) },
    search,
    windowYear
  );
  if (res.kind !== "movie" || !res.hit) {
    return { ai, kind: res.kind, ambiguous: res.ambiguous };
  }

  // Cast for a NEW (non-pool) movie hit only — TMDb, never the LLM. The SAME
  // call carries the country fields the seam-(b) gate needs, so the gate is free:
  // it is fetched for exactly the non-pool films the guard governs, and never for
  // a pool film (which the guard must never touch).
  let cast: string[] | undefined;
  let countries: CountryFields | undefined;
  if (!poolByTmdbId.has(res.hit.id)) {
    const credits = await deps.fetchCredits(res.hit.id);
    if (credits.leadCast.length > 0) cast = credits.leadCast;
    countries = credits.countries;
  }
  return {
    ai, kind: "movie", hit: res.hit, ambiguous: res.ambiguous,
    ...(cast ? { cast } : {}),
    ...(countries ? { countries } : {}),
  };
}

// ── Builders ────────────────────────────────────────────────────────────────

function posterUrlFromPath(path: string | undefined): string | undefined {
  return path ? `https://image.tmdb.org/t/p/w500${path}` : undefined;
}

function buildFromPool(
  r: Release,
  ai: AiResolution | undefined,
  window: BucketWindow,
  pillar: string,
  rankByTmdbId: Map<number, number>,
  cap: number
): ReconciledFilm {
  const aiFilm = ai?.ai;
  const da = assessDates(r, aiFilm, window);

  // OTT-no-platform warn (manifest-style), only relevant when the window passed.
  let landingStatus = da.landingStatus;
  let landingReason = da.reason;
  let warnReason: string | undefined;
  const platformKnown = r.platform.length > 0 || !!aiFilm?.platform;
  if (landingStatus === "pass" && window.dateField === "ott" && !platformKnown) {
    landingStatus = "warn";
    landingReason = "OTT arrival with no known platform";
    warnReason = "OTT arrival with no known platform";
  }

  const rank = r.tmdbId !== undefined ? rankByTmdbId.get(r.tmdbId) : undefined;
  const wasBelowCap = ai !== undefined && rank !== undefined && rank >= cap;
  const cast = r.leadCast && r.leadCast.length > 0 ? r.leadCast : r.cast.length > 0 ? r.cast : undefined;
  const platform = aiFilm?.platform ?? (r.platform.length > 0 ? r.platform.join(", ") : undefined);
  const year = r.releaseDate && ISO.test(r.releaseDate) ? Number.parseInt(r.releaseDate.slice(0, 4), 10) : undefined;

  // Fix B — write the known platform back into the Release the renderer reads.
  // Only when r.platform is empty (JustWatch missed / stub had none) AND the
  // reconciled press platform maps CLEANLY to an enum value via toPlatform. A
  // comma-joined string or unmapped display variant returns undefined → leave []
  // (the honest "STREAMING TBA" path) rather than inject raw text that would
  // drop the logo and fall to brass.
  const enumPlatform = r.platform.length === 0 ? toPlatform(platform) : undefined;
  const release: Release = enumPlatform ? { ...r, platform: [enumPlatform] } : r;

  const f: ReconciledFilm = {
    ...(r.tmdbId !== undefined ? { tmdbId: r.tmdbId } : {}),
    title: r.title,
    language: r.language,
    pillar,
    ...(platform ? { platform } : {}),
    ...(da.effective ? { date: da.effective } : {}),
    dateSource: da.dateSource,
    ...(aiFilm?.sources?.[0]?.url ? { sourceUrl: aiFilm.sources[0]!.url } : {}),
    ...(aiFilm?.confidence ? { confidence: aiFilm.confidence } : {}),
    foundIn: ai ? ["tmdb", "ai-net"] : ["tmdb"],
    status: "confirmed",
    landingStatus,
    ...(landingReason ? { landingReason } : {}),
    tier: "yellow",
    reasons: [],
    ...(ai?.ambiguous ? { ambiguousMatch: true } : {}),
    ...(da.ottDateFromPress ? { ottDateFromPress: true } : {}),
    ...(wasBelowCap ? { wasBelowCap: true } : {}),
    ...(da.conflictDetail ? { conflictDetail: da.conflictDetail } : {}),
    ...(cast ? { cast } : {}),
    resolvedTitle: r.title,
    ...(r.posterUrl ? { posterUrl: r.posterUrl } : {}),
    ...(year !== undefined ? { year } : {}),
    release,
  };
  if (warnReason && !f.reasons.includes(warnReason)) f.reasons.push(warnReason);
  return f;
}

function buildFromNewAi(
  res: AiResolution,
  window: BucketWindow,
  pillar: string,
  wikiLanguageIndex?: ReadonlyMap<string, string>
): ReconciledFilm {
  const hit = res.hit!;
  const ai = res.ai;
  // WD-ENG-07 — NAME THE LANGUAGE INSTEAD OF SHRUGGING.
  // languageForCode maps any unrecognised ISO to the "Other" placeholder, and
  // "Other" is not a language — it is the absence of one, and it reaches the
  // card's language row as such. Agadha lands here: TMDb carries it as "en"
  // (provisional), so the code says "Other" while the List of Telugu films of
  // 2026 has been saying Telugu all along.
  //
  // The index is consulted ONLY when the code produced "Other". A resolved
  // language is never overwritten — Wikipedia is the fallback authority here,
  // not the primary one.
  const coded = languageForCode(hit.originalLanguage);
  const fromWiki =
    coded === "Other"
      ? wikiLanguageFor(wikiLanguageIndex, ai.title) ?? wikiLanguageFor(wikiLanguageIndex, hit.title)
      : undefined;
  const language = (fromWiki as typeof coded | undefined) ?? coded;
  if (fromWiki) {
    log.info(`  [lang-index] "${ai.title}": TMDb code "${hit.originalLanguage ?? "<absent>"}" → "Other"; Wikipedia list says ${fromWiki} — using ${fromWiki}.`);
  }
  const da = assessDates(null, ai, window);
  const poster = posterUrlFromPath(hit.posterPath);

  // Build the TMDb-authoritative Release record. Title/poster/cast come from
  // TMDb; only platform + date come from the press (the LLM).
  const theatricalDate = ai.date ?? hit.releaseDate;
  const releaseDates: { theatrical?: string; ott?: string } =
    pillar === "ott"
      ? { ...(ai.date ? { ott: ai.date } : {}) }
      : { ...(theatricalDate ? { theatrical: theatricalDate } : {}) };

  // Fix B (Blast-class rescue) — TMDb missed this film entirely, so the ONLY
  // platform signal is the press (ai.platform). Normalize it through toPlatform
  // (enum only; unmapped/comma-joined → [] so the card honestly shows TBA).
  const enumPlatform = toPlatform(ai.platform);

  const release: Release = {
    id: `tmdb-${hit.id}`,
    tmdbId: hit.id,
    title: hit.title,
    language,
    isSeries: false,
    platform: enumPlatform ? [enumPlatform] : [],
    releaseDate: ai.date ?? hit.releaseDate ?? "",
    ...(Object.keys(releaseDates).length > 0 ? { releaseDates } : {}),
    genre: [],
    cast: res.cast ?? [],
    ...(res.cast && res.cast.length > 0 ? { leadCast: res.cast } : {}),
    synopsis: "",
    ...(poster ? { posterUrl: poster } : {}),
    subtitleLanguages: [],
    sources: ["ai-net", "tmdb-search"],
    fetchedAt: new Date().toISOString(),
  };

  return {
    tmdbId: hit.id,
    title: hit.title,
    language,
    pillar,
    ...(ai.platform ? { platform: ai.platform } : {}),
    ...(da.effective ? { date: da.effective } : {}),
    dateSource: da.dateSource,
    ...(ai.sources?.[0]?.url ? { sourceUrl: ai.sources[0]!.url } : {}),
    ...(ai.confidence ? { confidence: ai.confidence } : {}),
    foundIn: ["ai-net"],
    status: "confirmed",
    landingStatus: da.landingStatus,
    ...(da.reason ? { landingReason: da.reason } : {}),
    tier: "yellow",
    reasons: [],
    ...(res.ambiguous ? { ambiguousMatch: true } : {}),
    ...(da.ottDateFromPress ? { ottDateFromPress: true } : {}),
    ...(da.conflictDetail ? { conflictDetail: da.conflictDetail } : {}),
    ...(res.cast ? { cast: res.cast } : {}),
    resolvedTitle: hit.title,
    ...(poster ? { posterUrl: poster } : {}),
    ...(hit.year !== undefined ? { year: hit.year } : {}),
    release,
  };
}

function buildUnverified(res: AiResolution, pillar: string): ReconciledFilm {
  // Title + source ONLY. No date, platform, language, cast, or poster — nothing
  // that would be fabricated. Hard-pinned 🔴.
  const ai = res.ai;
  return {
    title: ai.title,
    language: "Unknown",
    pillar,
    dateSource: "none",
    ...(ai.sources?.[0]?.url ? { sourceUrl: ai.sources[0]!.url } : {}),
    foundIn: ["ai-net"],
    status: "unverified",
    tier: "red",
    reasons: ["unverified — no TMDb match; title + source only"],
  };
}

// ── Possible-duplicate flagging (never merges) ──────────────────────────────

function flagDuplicates(films: ReconciledFilm[]): void {
  const groups = new Map<string, ReconciledFilm[]>();
  for (const f of films) {
    const key = normalizeTitle(f.title);
    const arr = groups.get(key) ?? [];
    arr.push(f);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const ids = new Set(arr.map((f) => f.tmdbId).filter((x): x is number => x !== undefined));
    const hasUndef = arr.some((f) => f.tmdbId === undefined);
    // Same single id and no id-less member ⇒ genuinely the same film (already
    // joined). Anything else ⇒ ambiguous; FLAG every member, never merge.
    const sameFilm = ids.size === 1 && !hasUndef;
    if (!sameFilm) for (const f of arr) f.possibleDuplicate = true;
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function reconcile(input: ReconcileInput, deps: ReconcileDeps): Promise<ReconcileResult> {
  const { pillar, tmdbPool, aiFilms, window } = input;
  const cap = input.cap ?? 40;
  const windowYear = Number.parseInt(window.start.slice(0, 4), 10);

  const poolByTmdbId = new Map<number, Release>();
  for (const r of tmdbPool) if (r.tmdbId !== undefined) poolByTmdbId.set(r.tmdbId, r);

  const ranked = [...tmdbPool].sort((a, b) => (b.tmdbPopularity ?? 0) - (a.tmdbPopularity ?? 0));
  const rankByTmdbId = new Map<number, number>();
  ranked.forEach((r, i) => { if (r.tmdbId !== undefined) rankByTmdbId.set(r.tmdbId, i); });

  // Resolve every AI film against TMDb (the only network step — injected).
  const resolutions = await Promise.all(
    aiFilms.map((f) => resolveAiFilm(f, deps, windowYear, poolByTmdbId))
  );

  const aiByPoolId = new Map<number, AiResolution>();
  const newMovies: AiResolution[] = [];
  const nonIndian: AiResolution[] = [];
  const nonIndianCountry: AiResolution[] = [];
  const unverified: AiResolution[] = [];
  const seriesRejected: AiResolution[] = [];
  // WD-ENG-06 — films whose language could not be established either way.
  const languageUnresolved: AiResolution[] = [];
  for (const res of resolutions) {
    if (res.kind === "movie" && res.hit) {
      if (poolByTmdbId.has(res.hit.id)) {
        // Corroborates a POOL film (foundIn will include "tmdb"). The
        // Indian-language guard NEVER applies here — pool films are Indian by
        // construction and must never be dropped/downgraded by it.
        if (!aiByPoolId.has(res.hit.id)) aiByPoolId.set(res.hit.id, res);
      } else {
        // NEW ai-net discovery — apply the Indian-language guard, then the
        // country gate beside it. They answer DIFFERENT questions: the first is
        // "what language is it", the second "where is it from".
        //
        // WD-ENG-12 — THIS COMMENT USED TO NAME MASTUL AS THE WORKED EXAMPLE,
        // and it was wrong about the path. It said Mastul "passes a bn-shaped
        // language check and fails the country check". It cannot: INDIAN_LANG_CODES
        // is the seven PILLAR codes {te,ta,ml,hi,kn,mr,pa} and deliberately
        // excludes "bn", so a Bengali film is rejected as "non-Indian-language"
        // and NEVER REACHES the country gate at all. The real Mastul was stopped
        // one step earlier than the comment claimed.
        //
        // The gate below is still load-bearing, just for a different shape: a
        // film in a PILLAR language that is produced abroad — the ta/BD case —
        // which the language check genuinely does pass. Both paths are pinned in
        // language-guard.test.ts ("a PILLAR-language film from a foreign country
        // still rejects on COUNTRY" and "a Bengali film rejects on LANGUAGE").
        //
        // ── WD-ENG-06: UNKNOWN IS NOT FOREIGN, AND ONE FIELD IS NOT A VERDICT ──
        // This branch used to be `if (!(iso && INDIAN_LANG_CODES.has(iso)))
        // nonIndian.push(res)` — a single TMDb field, consulted alone, failing
        // CLOSED. Two separate faults lived in that line:
        //
        //   1. A MISSING iso was condemned as "non-Indian-language". Absence of
        //      evidence is not evidence of foreignness, and the country gate
        //      three lines below has always said so (it fail-OPENS on missing
        //      country data, precisely so TMDb gaps cannot eat a real film).
        //      Two guards, opposite philosophies, and the strict one ran first
        //      on the least reliable field.
        //
        //   2. A PROVISIONAL iso was condemned just as confidently. This is what
        //      actually happened: Agadha (tmdb 1747034) is a Telugu film opening
        //      2026-08-14, listed in the List of Telugu films of 2026, and named
        //      in TBSI's own first comment — and TMDb carries it as `"en"` with
        //      `origin_country: ["IN"]` on the same record. The guard rejected it
        //      on the wrong half of a record whose other half said India, and it
        //      never reached the country gate that would have passed it.
        //
        // So a non-Indian language code no longer ends the question; it opens
        // it. Two pieces of evidence are consulted, both already available:
        // a Wikipedia list that names the title, and INDIA STATED ON THE TMDB
        // RECORD ITSELF. Only when neither supports India does the film reject —
        // with today's label, so genuinely foreign films are untouched.
        const iso = res.hit.originalLanguage;
        if (iso && INDIAN_LANG_CODES.has(iso)) {
          const verdict = isIndianFilm(res.countries ?? {});
          log.info(countryGateLine("reconcile", res.hit.title, res.hit.id, verdict));
          if (verdict.ok) newMovies.push(res);
          else nonIndianCountry.push(res);
        } else {
          // EVIDENCE 1 — a Wikipedia "List of <Language> films of <year>" names it.
          const wikiLang = wikiLanguageFor(input.wikiLanguageIndex, res.ai.title)
            ?? wikiLanguageFor(input.wikiLanguageIndex, res.hit.title);
          // EVIDENCE 2 — TMDb itself states India. `present` is required: the
          // country gate fail-opens on EMPTY country data, and an absence must
          // not be read as an endorsement here.
          const verdict = isIndianFilm(res.countries ?? {});
          const indiaStated = verdict.present && verdict.ok;

          if (wikiLang || indiaStated) {
            log.info(
              `  [lang-guard] "${res.ai.title}": TMDb original_language=${iso ?? "<absent>"} is not an Indian code, ` +
              `but ${wikiLang ? `the List of ${wikiLang} films names it` : `TMDb states origin ${verdict.countries.join(",")}`}` +
              ` — treated as Indian, country gate decides.`
            );
            log.info(countryGateLine("reconcile", res.hit.title, res.hit.id, verdict));
            if (verdict.ok) newMovies.push(res);
            else nonIndianCountry.push(res);
          } else if (!iso) {
            // NO language code and no corroboration. Honest and DISTINCT: we do
            // not know, rather than "it is foreign".
            languageUnresolved.push(res);
          } else {
            nonIndian.push(res);
          }
        }
      }
    } else if (res.kind === "series") {
      seriesRejected.push(res);
    } else {
      unverified.push(res);
    }
  }

  const reconciled: ReconciledFilm[] = [];
  // 1) Pool baseline (+ AI merge by shared id). Every pool film survives.
  for (const r of tmdbPool) {
    const ai = r.tmdbId !== undefined ? aiByPoolId.get(r.tmdbId) : undefined;
    reconciled.push(buildFromPool(r, ai, window, pillar, rankByTmdbId, cap));
  }
  // 2) New AI movies TMDb discovery missed (Indian-language only).
  for (const res of newMovies) reconciled.push(buildFromNewAi(res, window, pillar, input.wikiLanguageIndex));
  // 3) Unverified AI leads (red, no release).
  for (const res of unverified) reconciled.push(buildUnverified(res, pillar));

  // 4) Flag possible dupes, then assign tiers.
  flagDuplicates(reconciled);
  for (const f of reconciled) {
    const { tier, reasons } = assignTier(f);
    f.tier = tier;
    for (const r of reasons) if (!f.reasons.includes(r)) f.reasons.push(r);
  }

  // Rejected list: TMDb tv-only matches + non-Indian-language new discoveries +
  // the LLM's own rejections. Each carries enough to audit it in the review.
  const rejected: RejectedExtraction[] = [
    ...seriesRejected.map((res) => ({
      title: res.ai.title,
      reason: res.ai.isSeries ? "series (LLM isSeries)" : "series (TMDb /search/tv match, no qualifying movie)",
      ...(res.ai.sources?.[0]?.url ? { sourceUrl: res.ai.sources[0]!.url } : {}),
    })),
    ...nonIndian.map((res) => ({
      title: res.ai.title,
      reason: "non-Indian-language",
      ...(res.hit?.originalLanguage ? { originalLanguage: res.hit.originalLanguage } : {}),
      ...(res.ai.sources?.[0]?.url ? { sourceUrl: res.ai.sources[0]!.url } : {}),
    })),
    // WD-ENG-06 — DISTINCT from "non-Indian-language", and the difference is the
    // whole point: this film's language is UNKNOWN, not foreign. It carries no
    // TMDb language code, no Wikipedia list names it, and TMDb states no country.
    // Nothing here says "not Indian"; what it says is "we could not tell".
    //
    // WHY A REJECT AND NOT A RED-TIER CANDIDATE (the choice Part 2 asked me to
    // justify): reconcile assigns tier from DATE, PROVENANCE and STATUS — never
    // from language — so an unresolved-language film would land red on its
    // provenance alone, and red never renders. Emitting it as a candidate would
    // therefore add a Release whose `language` could only be the "Other"
    // placeholder, feeding a card language row and a pillar it belongs to no
    // more than the reject list does. The reject path surfaces it in the SAME
    // review artifact, under a label that states the actual problem, without
    // fabricating a language for it. If it later needs to render, the fix is a
    // resolved language — not a placeholder.
    ...languageUnresolved.map((res) => ({
      title: res.ai.title,
      reason: "language unresolved",
      ...(res.ai.sources?.[0]?.url ? { sourceUrl: res.ai.sources[0]!.url } : {}),
    })),
    // DISTINCT from "non-Indian-language" on purpose: this film's language was
    // fine and TMDb said it is not from India. Collapsing the two reasons would
    // hide the Mastul class in the review.
    ...nonIndianCountry.map((res) => ({
      title: res.ai.title,
      reason: `non-Indian-country [${isIndianFilm(res.countries ?? {}).countries.join(",")}]`,
      ...(res.hit?.originalLanguage ? { originalLanguage: res.hit.originalLanguage } : {}),
      ...(res.ai.sources?.[0]?.url ? { sourceUrl: res.ai.sources[0]!.url } : {}),
    })),
    ...(input.aiRejected ?? []),
  ];

  const counts = {
    total: reconciled.length,
    green: reconciled.filter((f) => f.tier === "green").length,
    yellow: reconciled.filter((f) => f.tier === "yellow").length,
    red: reconciled.filter((f) => f.tier === "red").length,
    addedByAiNet: reconciled.filter(
      (f) => f.status === "confirmed" && f.foundIn.length === 1 && f.foundIn[0] === "ai-net"
    ).length,
    flagged: reconciled.filter((f) => f.tier !== "green").length,
  };

  return { pillar, window: { start: window.start, end: window.end }, reconciled, rejected, counts };
}
