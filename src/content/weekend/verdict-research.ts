// src/content/weekend/verdict-research.ts
// Grounded Verdict research (Phase 1): for ONE film, web-search real published
// reviews, extract the critic ratings/sentiment ACTUALLY found, and compute a
// deterministic TBSI score + ★/5 + verdict + confidence + paraphrased copy.
//
// HONESTY CONTRACT: this module never invents a rating, quote, source, or url.
// Everything reported comes from real search results; if nothing is found it
// returns found:false with confidence 'none' (the "NO SCORE YET" path) — never a
// fabricated verdict. The numeric score is computed HERE (computeVerdictScore),
// not by the model — the model only reports what it read.
//
// Cost: each researchVerdict() call runs the Max-plan Claude Code CLI with its
// built-in WebSearch tool — no Anthropic API key, no per-call API billing. It
// still belongs to the JOB path only: the render:* sample path must never import
// or call this.

import { z } from "zod";
import { callClaude } from "../claude.js";
import type { ModelChoice } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
// SHARED with the stamp path (buildStampContext) — one definition so the two
// TMDb vote floors can't drift. Re-homing to src/shared/ is a later cleanup.
import { TMDB_FALLBACK_MIN_VOTES } from "../../rendering/_shared.js";

// ──────────────────────────────────────────────────────────────────────────
// TUNABLE EDITORIAL DIALS (Phase 1). All weights/thresholds live here.
// ──────────────────────────────────────────────────────────────────────────

/** Web searches the model may run per film (prompt-level cap; CLI WebSearch tool). */
export const MAX_SEARCHES_PER_FILM = 5;

/**
 * Cache version for the RAW research blob (the cached value in researchFilmCached).
 * Folded into the cache key. BUMP THIS ONLY when the research PROMPT text
 * (buildResearchPrompt) OR the ResearchResponseSchema SHAPE changes — i.e. when an
 * already-cached raw blob would no longer mean what a fresh fetch produces. Do NOT
 * bump for SCORING changes (computeVerdictScore / classification): scoring runs
 * fresh OUTSIDE the cache, so it re-tunes for free and must keep hitting the
 * existing cache. Bumping on a scoring change throws that property away.
 */
export const RESEARCH_CACHE_VERSION = "v1";

/** Model for the per-film research call — routes to Claude Opus 4.8. */
const RESEARCH_MODEL: ModelChoice = "opus";

/**
 * TBSI blend weights — applied over WHICHEVER axes are present and then
 * re-normalized, so a film with credible critics still scores. The third axis is
 * REVIEW TONE (mean critic-review sentiment): a minor nudge on top of the
 * published critic numbers. It is NOT popularity/heat — no views/Trends/Reddit/
 * buzz feeds the grounded score at all (Heat is a separate axis, a later build).
 * The old `BUZZ_WEIGHT` is renamed REVIEW_TONE_WEIGHT (same value) so the buzz/
 * heat namespace is left free for that build.
 */
export const CRITIC_WEIGHT = 0.55;
export const AUDIENCE_WEIGHT = 0.35;
export const REVIEW_TONE_WEIGHT = 0.10;

/**
 * Verdict thresholds on the SAME rounded ★/5 the reader sees — NOT the raw
 * tbsiScore. Deriving the verdict from `star` guarantees the star and the
 * verdict can never disagree at a tier boundary (e.g. ★4.0 is always "Must
 * Watch", never "Worth a Try").
 */
export const MUST_WATCH_STAR_MIN = 4.0; // ★ ≥ 4.0 → Must Watch
export const WORTH_TRY_STAR_MIN = 3.0; // ★ ≥ 3.0 → Worth a Try; else Skip

// ── Evidence gate on Must Watch (release-day honesty) ──────────────────────
// On the Wed→Fri window the evidence base is THIN: a couple of raves can push
// the raw star past 4.0 with almost nothing behind it. So the top recommendation
// is gated on real evidence — credible critics ANCHOR it, audience only
// CORROBORATES. When the bar isn't met the star is clamped just below the Must
// Watch line; the badge still shows the TRUE credible-critic count + EARLY, so
// nothing is hidden. The cap NEVER pushes a score DOWN past its tier — a real
// Skip stays a Skip; it only blocks an under-evidenced film from Must Watch.
/** Credible critics (Tier A/B, with a published rating) needed to allow ★4.0+. */
export const MUST_WATCH_MIN_CRITICS = 3;
/** Audience votes that let 2 credible critics substitute for the 3rd. BOTH the
 *  2-critic anchor AND this vote floor are required, so a fresh fan-brigaded
 *  number can't mint a Must Watch on its own. Tunable. */
export const MUST_WATCH_AUDIENCE_VOTES = 1000;
/** Star ceiling when the Must Watch evidence bar isn't met (just under 4.0). */
export const WORTH_TRY_STAR_CEIL = 3.9;

/** Credible critics that make a read 'firm' (also the override's 2-critic anchor). */
export const MIN_CRITICS_FOR_FIRM = 2;

// ──────────────────────────────────────────────────────────────────────────
// SOURCE REGISTRY — outlet → credibility tier. Editorially maintained.
//
// Classification is keyed on BOTH the url host AND the source name, so a bare
// domain or a renamed/abbreviated outlet still matches:
//   Tier A — established critics; full weight in the consensus.
//   Tier B — real but smaller outlets (anything not in A or C). Counted at the
//            SAME weight as A in the median for now: the median is already
//            outlier-robust and the brief defers weighted-median complexity. To
//            down-weight Tier B later, switch criticConsensus to a weighted
//            median keyed on tierOf() — that's the single extension point.
//   Tier C — grade-inflation / non-credible (rave farms). EXCLUDED from the
//            critic consensus AND the credible-critic count (and every axis).
//
// A Tier A/B outlet's OWN star-rated review is a CRITIC anchor. A social/tweet
// roundup ("Twitter review", "X review", "N tweets to read") is AUDIENCE
// sentiment, never a critic — see isRoundup(). A review with no published score
// is likewise treated as audience sentiment, not a critic anchor.
// ──────────────────────────────────────────────────────────────────────────

/** Tier A — established critics (full weight). Extend by adding a host and/or a
 *  lowercased name token; matching is substring/suffix on host and on name. */
export const TIER_A_SOURCES: { domains: string[]; names: string[] } = {
  domains: [
    "123telugu.com", "filmcompanion.in", "thehindu.com", "timesofindia.indiatimes.com",
    "indianexpress.com", "cinemaexpress.com", "newindianexpress.com", "ottplay.com",
    "hindustantimes.com", "gulte.com", "greatandhra.com", "sify.com",
    "onlykollywood.com", "behindwoods.com", "baradwajrangan.com",
  ],
  names: [
    "123telugu", "film companion", "the hindu", "times of india", "cinema express",
    "new indian express", "indian express", "ottplay", "hindustan times", "gulte",
    "greatandhra", "great andhra", "sify", "only kollywood", "behindwoods",
    "baradwaj rangan",
  ],
};

/** Tier C — EXCLUDE from the score entirely (grade-inflation / non-credible).
 *  Seeded with the outlet named in the brief; editors extend conservatively
 *  (denylisting a real outlet silently drops its rating). Social roundups are
 *  caught separately by isRoundup() regardless of tier. */
export const TIER_C_SOURCES: { domains: string[]; names: string[] } = {
  domains: ["indian.community"],
  names: ["indian.community", "indian community"],
};

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type Confidence = "high" | "medium" | "low" | "none";
export type GroundedVerdict = "Must Watch" | "Worth a Try" | "Skip";

export interface CriticRating {
  source: string;
  url: string;
  /** Outlet's own rating normalized to 0-5; null when the outlet gives none. */
  explicitScore: number | null;
  /** Model's 0-5 read of the review's tone (0 pan … 5 rave). */
  sentimentScore: number;
}

export interface VerdictResearch {
  found: boolean;
  criticRatings: CriticRating[];
  /** Tier A/B non-roundup critics (explicit OR sentiment-only) — the credible
   *  anchor set. Feeds the evidence gate/cap AND the card badge's "N CRITICS"
   *  (NOT criticRatings.length, which includes excluded Tier C and roundups). */
  credibleCriticCount: number;
  /** 0-10 audience signal REUSED from the film's aggregator data (IMDb). Not re-fetched. */
  audienceScore: number | null;
  /** Short qualitative chatter note only (display copy; never feeds the score). */
  buzzNote: string;
  /** 0-10, computed deterministically; null when confidence is 'none'. */
  tbsiScore: number | null;
  /** 0-5 = tbsiScore / 2, 1dp; null when confidence is 'none'. */
  star: number | null;
  verdict: GroundedVerdict | null;
  confidence: Confidence;
  summaryLine: string;
  theRead: string;
  watchIf: string;
  sources: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// LLM response schema — the model reports ONLY what it found. It does NOT
// produce the numeric score/verdict/confidence (those are computed below).
// ──────────────────────────────────────────────────────────────────────────

const CriticRatingSchema = z.object({
  source: z.string(),
  url: z.string(),
  explicitScore: z.number().min(0).max(5).nullable(),
  sentimentScore: z.number().min(0).max(5),
});

const ResearchResponseSchema = z.object({
  found: z.boolean(),
  criticRatings: z.array(CriticRatingSchema),
  buzzNote: z.string(),
  summaryLine: z.string(),
  theRead: z.string(),
  watchIf: z.string(),
  sources: z.array(z.string()),
});

type ResearchResponse = z.infer<typeof ResearchResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Deterministic scoring — PURE, no API, unit-testable.
// ──────────────────────────────────────────────────────────────────────────

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Median of a non-empty list. Even count → mean of the two middle values. */
const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

// ── Source classification (tier + roundup) — PURE, registry-driven ──────────

export type SourceTier = "A" | "B" | "C";

/** Lowercased registrable host of a url ("" when unparseable). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function matchesRegistry(
  reg: { domains: string[]; names: string[] },
  host: string,
  name: string
): boolean {
  return (
    reg.domains.some(d => host === d || host.endsWith(`.${d}`)) ||
    reg.names.some(n => name.includes(n))
  );
}

/** Credibility tier of a found rating, from its url host + source name. */
export function tierOf(rating: CriticRating): SourceTier {
  const host = hostOf(rating.url);
  const name = rating.source.toLowerCase();
  if (matchesRegistry(TIER_C_SOURCES, host, name)) return "C";
  if (matchesRegistry(TIER_A_SOURCES, host, name)) return "A";
  return "B";
}

/** Social/tweet roundup → AUDIENCE sentiment, not a critic. Matches roundup
 *  tokens in the url or source name (Pinkvilla/Filmibeat "Twitter review",
 *  "X review", "N tweets to read" pieces). Token-anchored so a normal "/review"
 *  slug or "...express" host never trips it. */
const ROUNDUP_RE =
  /twitter|tweets?\b|netizen|\bx[-\s]?review|public[-\s]?talk|fan[-\s]?reaction|audience[-\s]?reaction|social[-\s]?media/i;
export function isRoundup(rating: CriticRating): boolean {
  return ROUNDUP_RE.test(rating.url) || ROUNDUP_RE.test(rating.source);
}

/** A CRITIC anchor: a Tier A/B outlet review that is not a social roundup —
 *  REGARDLESS of whether we parsed an explicit score. Credibility is the
 *  OUTLET's, not the parser's: a real critic whose star rating we failed to
 *  extract is still a real critic (a sentiment-only review counts). The explicit
 *  score, when present, only sharpens the median; the ≥3-credible Must Watch cap
 *  still backstops re-inflation, so a single sentiment-only rave can't reach ★4.0+. */
function isCredibleCritic(rating: CriticRating): boolean {
  return tierOf(rating) !== "C" && !isRoundup(rating);
}

/**
 * Aggregator-derived audience signal, REUSED from the film's existing ratings
 * (the computeTbsiScore inputs) — never re-fetched here. SUPPORTING only: it
 * feeds the blend, the Must Watch override, and confidence. It can NEVER anchor
 * a verdict by itself — with zero credible critics there is no grounded score,
 * no matter how strong the numbers (release-day vote counts are tiny and
 * brigade-prone).
 */
export interface AudienceSignal {
  /** IMDb average, 0-10. */
  imdbRating: number | null;
  /** IMDb vote count — gates the Must Watch override + feeds confidence. */
  imdbVotes: number | null;
  /** Letterboxd average, 0-5. */
  letterboxd: number | null;
  /** TMDb community vote average, 0-10. */
  tmdbVoteAverage: number | null;
  /** TMDb vote count — gates tmdbVoteAverage behind the vote floor (a brand-new
   *  film reports average 0.0 on 0 votes, which must NOT enter the blend). */
  tmdbVoteCount: number | null;
}

/** Empty audience signal — when no aggregator data is available. */
export const NO_AUDIENCE: AudienceSignal = {
  imdbRating: null,
  imdbVotes: null,
  letterboxd: null,
  tmdbVoteAverage: null,
  tmdbVoteCount: null,
};

/** Build the supporting audience signal from a film's existing aggregator data. */
export function audienceSignalOf(film: Release): AudienceSignal {
  return {
    imdbRating: typeof film.imdbRating === "number" ? film.imdbRating : null,
    imdbVotes: typeof film.imdbVotes === "number" ? film.imdbVotes : null,
    letterboxd: typeof film.letterboxd === "number" ? film.letterboxd : null,
    tmdbVoteAverage: typeof film.tmdbVoteAverage === "number" ? film.tmdbVoteAverage : null,
    tmdbVoteCount: typeof film.tmdbVoteCount === "number" ? film.tmdbVoteCount : null,
  };
}

/**
 * Raw research for one film — EXACTLY what the web search produces (the parsed
 * ResearchResponse) plus the reused AudienceSignal, BEFORE any scoring. THIS is
 * what gets cached (see researchFilmCached): scoring (computeVerdictScore) runs
 * FRESH on top of it on every invocation, so re-tuning the scorer costs nothing
 * and a stale verdict is structurally impossible. Bump RESEARCH_CACHE_VERSION
 * when this shape — or the prompt that fills it — changes.
 */
export interface RawResearch extends ResearchResponse {
  audience: AudienceSignal;
}

/**
 * Turn the found critic ratings + the reused audience signal into a grounded
 * TBSI score, ★/5, verdict, and confidence. PURE function.
 *
 * - Each found rating is classified (tierOf + isRoundup): a Tier A/B non-roundup
 *   review → CREDIBLE CRITIC (explicit OR sentiment-only); Tier C → dropped
 *   entirely; a social roundup → AUDIENCE sentiment.
 * - criticConsensus (0-10): MEDIAN of the credible critics' score ×2 — explicit
 *   when parsed, else sentiment (Tier C and roundups excluded). Outlier-robust.
 * - audience axis (0-10): mean of the available aggregator signals (IMDb,
 *   Letterboxd×2, TMDb) PLUS any audience-classified review sentiment ×2.
 * - reviewTone (0-10): mean of the credible critics' SENTIMENT ×2 — a minor tone
 *   nudge on top of the published numbers (NOT popularity/heat).
 * - tbsiScore: weighted blend (CRITIC/AUDIENCE/REVIEW_TONE) over the axes
 *   present, re-normalized; rawStar = tbsiScore / 2.
 * - EVIDENCE CAP: rawStar may pass 4.0 only when meetsMustWatchEvidence (≥3
 *   credible critics, or ≥2 with ≥MUST_WATCH_AUDIENCE_VOTES IMDb votes);
 *   otherwise the star is clamped to WORTH_TRY_STAR_CEIL. The verdict derives
 *   from the FINAL star, so ★ and stamp can never disagree. The cap only blocks
 *   inflated Must Watch — it never pushes a genuinely low score down a tier.
 * - GATE: zero credible critics (or found:false) → tbsiScore/star/verdict all
 *   null (the no-score "too early to call" path). Audience alone NEVER grounds a
 *   verdict.
 */
export function computeVerdictScore(
  research: { found: boolean; criticRatings: CriticRating[] },
  audience: AudienceSignal
): {
  tbsiScore: number | null;
  star: number | null;
  verdict: GroundedVerdict | null;
  confidence: Confidence;
  credibleCriticCount: number;
} {
  const ratings = research.criticRatings;
  const nonExcluded = ratings.filter(r => tierOf(r) !== "C"); // Tier C dropped from every axis
  const credible = nonExcluded.filter(isCredibleCritic);
  const audienceReviews = nonExcluded.filter(r => !isCredibleCritic(r)); // roundups → audience
  const credibleCriticCount = credible.length;

  // GATE — credible critics ANCHOR every grounded verdict. No critic → no score,
  // regardless of audience (release-day votes are too thin/brigade-prone to mint
  // a verdict). Honesty contract: never a fabricated number.
  if (!research.found || credibleCriticCount === 0) {
    return { tbsiScore: null, star: null, verdict: null, confidence: "none", credibleCriticCount };
  }

  // CRITIC axis — median of the credible critics' scores (×2): the outlet's own
  // published score when we parsed one, else our read of the review's sentiment.
  // NO non-null assertion — `credible` now includes sentiment-only Tier-A/B
  // reviews, so the explicit score may be absent; falling back to sentiment keeps
  // a real critic in the consensus instead of dropping or zeroing it. Median
  // resists a lone dissent dragging the tier; Tier B counts equally with Tier A.
  const criticConsensus = median(
    credible.map(r => (r.explicitScore !== null ? r.explicitScore : r.sentimentScore) * 2)
  );

  // AUDIENCE axis — aggregator magnitudes (each → 0-10) plus any audience-class
  // review sentiment (×2). Present only when at least one audience signal exists;
  // otherwise the blend re-normalizes over CRITIC + REVIEW_TONE.
  const audienceParts: number[] = [];
  if (audience.imdbRating !== null) audienceParts.push(audience.imdbRating);
  if (audience.letterboxd !== null) audienceParts.push(audience.letterboxd * 2);
  // TMDb community average is trustworthy ONLY above the vote-count floor — a
  // brand-new film reports vote_average 0.0 on 0 votes, and that literal 0 must
  // NOT enter the mean as a real 0/10 pan (it manufactured false Skips). Same rule
  // the stamp path uses (shared TMDB_FALLBACK_MIN_VOTES). Below the floor — incl.
  // the zero-vote / unknown-count case — treat tmdbVoteAverage as ABSENT.
  if (audience.tmdbVoteAverage !== null && (audience.tmdbVoteCount ?? 0) >= TMDB_FALLBACK_MIN_VOTES) {
    audienceParts.push(audience.tmdbVoteAverage);
  }
  for (const r of audienceReviews) audienceParts.push(r.sentimentScore * 2);
  // Each component above enters only when present — a null/absent signal is
  // EXCLUDED from the mean, never folded in as 0. No signals → null (the blend
  // then re-normalizes over CRITIC + REVIEW_TONE).
  const audienceAxis = audienceParts.length ? mean(audienceParts) : null;

  // REVIEW TONE axis — mean of the credible critics' tone read (×2). A minor 0.10
  // nudge on top of the published numbers; NOT popularity/heat.
  const reviewTone = mean(credible.map(r => r.sentimentScore * 2));

  const signals: { w: number; v: number }[] = [
    { w: CRITIC_WEIGHT, v: criticConsensus },
    ...(audienceAxis !== null ? [{ w: AUDIENCE_WEIGHT, v: audienceAxis }] : []),
    { w: REVIEW_TONE_WEIGHT, v: reviewTone },
  ];
  const weightSum = signals.reduce((a, s) => a + s.w, 0);
  const tbsiScore = round1(signals.reduce((a, s) => a + s.w * s.v, 0) / weightSum);
  const rawStar = round1(tbsiScore / 2);

  // EVIDENCE CAP — credible critics anchor Must Watch; audience only corroborates
  // (2-critic anchor AND a real vote floor BOTH required, so a brigaded number
  // can't substitute on its own). When the bar isn't met, clamp the star just
  // under the Must Watch line. Never caps DOWNWARD past a tier — a real Skip
  // stays a Skip. tbsiScore stays the uncapped blend (not shown on the ★ seal).
  const imdbVotes = audience.imdbVotes ?? 0;
  const meetsMustWatchEvidence =
    credibleCriticCount >= MUST_WATCH_MIN_CRITICS ||
    (credibleCriticCount >= MIN_CRITICS_FOR_FIRM && imdbVotes >= MUST_WATCH_AUDIENCE_VOTES);
  const star = meetsMustWatchEvidence ? rawStar : Math.min(rawStar, WORTH_TRY_STAR_CEIL);

  // Verdict derives from the FINAL (capped) star — never the raw tbsiScore — so
  // the ★ and the verdict stamp can never split at a tier boundary.
  const verdict: GroundedVerdict =
    star >= MUST_WATCH_STAR_MIN ? "Must Watch" : star >= WORTH_TRY_STAR_MIN ? "Worth a Try" : "Skip";

  // Confidence from COUNTABLE evidence (not a vibe) — drives the seal's EARLY vs
  // TBSI badge. 'low' (a single credible critic) ⊆ the cap-firing set, so an
  // EARLY badge always coincides with a clamped star; the cap independently
  // blocks any sub-bar film from Must Watch regardless of the badge.
  const confidence: Confidence = meetsMustWatchEvidence
    ? "high"
    : credibleCriticCount >= MIN_CRITICS_FOR_FIRM
      ? "medium"
      : "low";

  return { tbsiScore, star, verdict, confidence, credibleCriticCount };
}

// ──────────────────────────────────────────────────────────────────────────
// Research call
// ──────────────────────────────────────────────────────────────────────────

export function buildResearchPrompt(film: Release, year: string): string {
  return `You are a film-review aggregator for The Big Screen Index. Research REAL published reviews for ONE film and report ONLY what you actually find via web search.

FILM:
- Title: ${film.title}
- Language: ${film.language}
- Year: ${year || "unknown"}
- Director: ${film.director ?? "unknown"}
- Platform: ${film.platform.length ? film.platform.join(", ") : "unknown"}

SEARCH (up to ${MAX_SEARCHES_PER_FILM} searches):
- Try queries like "${film.title} ${film.language} movie review rating ${year}", "${film.title} review", "${film.title} critics rating", plus outlet-specific variants.
- Read the results. Collect EVERY distinct CRITIC review you genuinely find (professional outlets / named critics — not random user comments).

FOR EACH CRITIC RATING (only ones that actually appear in your search results):
- source: the outlet or critic name (e.g. "The Hindu", "Film Companion").
- url: the REAL url from the results. Never invent, guess, or "reconstruct" a url — if you are not sure it is a real result, omit that rating.
- explicitScore: the outlet's OWN rating NORMALIZED to 0-5 (4/5→4, 8/10→4, 80%→4, 3.5/5→3.5, ★★★½→3.5). If the outlet gives NO numeric/star rating, use null.
- sentimentScore: YOUR read of the review's tone, 0-5 (0 pan, 2.5 mixed, 5 rave), grounded in the review's actual wording.

ALSO REPORT:
- buzzNote: one short qualitative phrase on chatter/anticipation IF evident (e.g. "strong pre-release buzz"); else "".
- summaryLine: <=12 words, the grounded one-line verdict, in YOUR words.
- theRead: 2-3 sentences paraphrasing the critical consensus (strengths + the main knock), in YOUR words.
- watchIf: "Watch if you liked ..." — a grounded comparable (film/genre/director).
- sources: the outlet names you actually used.

HONESTY — NON-NEGOTIABLE:
- Use ONLY ratings, sources, quotes, and urls that appear in your real search results. NEVER fabricate any of them.
- Paraphrase. Do NOT copy sentences from reviews. If you must quote, keep it UNDER 15 words and at most ONE quote per source.
- If you find ZERO real critic reviews: set found=false, criticRatings=[], and say so plainly in summaryLine/theRead (e.g. "No critic reviews published yet."). Do NOT guess a verdict from the premise, cast, or director.
- Do NOT output any numeric TBSI score or verdict yourself — those are computed downstream from your criticRatings. Just report what you found.

OUTPUT — STRICT JSON ONLY (no markdown, no prose before or after):
{
  "found": <true|false>,
  "criticRatings": [ { "source": "...", "url": "...", "explicitScore": <number 0-5 or null>, "sentimentScore": <number 0-5> } ],
  "buzzNote": "...",
  "summaryLine": "...",
  "theRead": "...",
  "watchIf": "...",
  "sources": ["..."]
}`;
}

/**
 * Robustly pull the JSON object out of a web-search reply: strip code fences,
 * try a direct parse, then fall back to the outermost {...} slice (the model
 * sometimes narrates around the JSON). Returns the validated shape or null.
 */
function parseResearchResponse(raw: string): ResearchResponse | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const result = ResearchResponseSchema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Score RAW research into a grounded VerdictResearch. PURE — runs OUTSIDE the
 * research cache (researchFilmCached caches the RawResearch blob, then calls
 * this), so the verdict ALWAYS reflects the current scoring logic and re-running
 * re-scores at zero cost. No web access, fixture-testable.
 */
export function scoreResearch(raw: RawResearch): VerdictResearch {
  const scored = computeVerdictScore({ found: raw.found, criticRatings: raw.criticRatings }, raw.audience);
  return {
    found: raw.found,
    criticRatings: raw.criticRatings,
    credibleCriticCount: scored.credibleCriticCount,
    audienceScore: raw.audience.imdbRating,
    buzzNote: raw.buzzNote,
    tbsiScore: scored.tbsiScore,
    star: scored.star,
    verdict: scored.verdict,
    confidence: scored.confidence,
    summaryLine: raw.summaryLine,
    theRead: raw.theRead,
    watchIf: raw.watchIf,
    sources: raw.sources,
  };
}

/** Empty raw research — the honest "nothing found" blob (no fabricated verdict). */
export function rawNotFound(audience: AudienceSignal): RawResearch {
  return {
    found: false,
    criticRatings: [],
    buzzNote: "",
    summaryLine: "",
    theRead: "",
    watchIf: "",
    sources: [],
    audience,
  };
}

/**
 * Interpret a raw research reply (text from the model) into a VerdictResearch:
 * parse → validate → deterministic score. Returns null if the reply can't be
 * parsed/validated. Exposed so the transport (CLI WebSearch) can be swapped in
 * tests without touching the honesty/scoring logic.
 */
export function interpretResearchReply(raw: string, audience: AudienceSignal): VerdictResearch | null {
  const parsed = parseResearchResponse(raw);
  return parsed ? scoreResearch({ ...parsed, audience }) : null;
}

/** Honest "nothing found" result — the NO SCORE YET path, no fabricated verdict.
 *  Scores the empty raw blob, so it stays in lockstep with scoreResearch(). */
export function notFound(audience: AudienceSignal): VerdictResearch {
  return scoreResearch(rawNotFound(audience));
}

/**
 * Fetch RAW research for ONE film via web search — the found flag + criticRatings
 * + buzzNote + copy + the reused AudienceSignal, BEFORE any scoring. Runs on the
 * Max-plan CLI with its built-in WebSearch tool. On an unparseable/invalid reply
 * it retries ONCE, then degrades to rawNotFound() — never throws into the job,
 * never fabricates. THIS is the cached unit (researchFilmCached caches it);
 * scoreResearch() runs afterwards, outside the cache.
 */
export async function fetchRawResearch(film: Release): Promise<RawResearch> {
  // Audience signal is REUSED from the aggregator (IMDb/Letterboxd/TMDb) — never
  // re-fetched here. Supporting only; credible critics anchor the verdict.
  const audience = audienceSignalOf(film);
  const year = (film.releaseDate ?? "").slice(0, 4);
  const basePrompt = buildResearchPrompt(film, year);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nYour previous reply was not valid JSON matching the required shape. Respond with ONLY the strict JSON object — no prose, no code fences.`;
    try {
      const raw = await callClaude(prompt, RESEARCH_MODEL, {
        webSearch: true,
      });
      const parsed = parseResearchResponse(raw);
      if (parsed) return { ...parsed, audience };
      log.warn(`fetchRawResearch(${film.title}): attempt ${attempt} — unparseable/invalid reply`);
    } catch (err) {
      log.warn(
        `fetchRawResearch(${film.title}): attempt ${attempt} errored — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return rawNotFound(audience);
}

/**
 * Research ONE film and return a grounded VerdictResearch (fetch raw → score).
 * Convenience wrapper; the JOB instead caches fetchRawResearch() and calls
 * scoreResearch() separately, so scoring stays OUTSIDE the cache boundary.
 */
export async function researchVerdict(film: Release): Promise<VerdictResearch> {
  return scoreResearch(await fetchRawResearch(film));
}
