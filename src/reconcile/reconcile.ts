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
import { resolveTitleToTmdb, languageForCode, INDIAN_LANG_CODES } from "../discovery/sources/resolveTitle.js";
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
  /** Top-billed cast for a movie id — TMDb, never the LLM. */
  fetchCredits: (tmdbId: number) => Promise<{ leadCast: string[] }>;
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
  ai: ExtractedFilm | undefined,
  window: BucketWindow
): DateAssessment {
  const tmdbDate = release ? qualifyingDate(release, window.dateField).date : null;
  const aiDate = ai?.date;
  const seen = ai?.datesSeen ?? [];
  const all = validDates(tmdbDate, aiDate, ...seen);

  const inWin = all.filter((d) => inWindow(d, window.start, window.end));
  const conflict =
    all.length >= 2 && (maxDayGap(all) > 2 || (inWin.length > 0 && inWin.length < all.length));
  const conflictDetail = conflict ? `dates seen: ${all.join(" vs ")}` : undefined;

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

  // Cast for a NEW (non-pool) movie hit only — TMDb, never the LLM.
  let cast: string[] | undefined;
  if (!poolByTmdbId.has(res.hit.id)) {
    const credits = await deps.fetchCredits(res.hit.id);
    if (credits.leadCast.length > 0) cast = credits.leadCast;
  }
  return { ai, kind: "movie", hit: res.hit, ambiguous: res.ambiguous, ...(cast ? { cast } : {}) };
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

function buildFromNewAi(res: AiResolution, window: BucketWindow, pillar: string): ReconciledFilm {
  const hit = res.hit!;
  const ai = res.ai;
  const language = languageForCode(hit.originalLanguage);
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
  const unverified: AiResolution[] = [];
  const seriesRejected: AiResolution[] = [];
  for (const res of resolutions) {
    if (res.kind === "movie" && res.hit) {
      if (poolByTmdbId.has(res.hit.id)) {
        // Corroborates a POOL film (foundIn will include "tmdb"). The
        // Indian-language guard NEVER applies here — pool films are Indian by
        // construction and must never be dropped/downgraded by it.
        if (!aiByPoolId.has(res.hit.id)) aiByPoolId.set(res.hit.id, res);
      } else {
        // NEW ai-net discovery — apply the Indian-language guard.
        const iso = res.hit.originalLanguage;
        if (iso && INDIAN_LANG_CODES.has(iso)) newMovies.push(res);
        else nonIndian.push(res);
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
  for (const res of newMovies) reconciled.push(buildFromNewAi(res, window, pillar));
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
