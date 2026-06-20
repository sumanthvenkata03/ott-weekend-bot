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
// Cost: each researchVerdict() call is a billed Anthropic request WITH web
// search. It belongs to the JOB path only. The render:* sample path must never
// import or call this.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { callClaude } from "../claude.js";
import type { ModelChoice } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";

// ──────────────────────────────────────────────────────────────────────────
// TUNABLE EDITORIAL DIALS (Phase 1). All weights/thresholds live here.
// ──────────────────────────────────────────────────────────────────────────

/** Web searches the model may run per film (server-side, billed). */
export const MAX_SEARCHES_PER_FILM = 5;

/** Cost-efficient model for the per-film research call (Sonnet-class). */
const RESEARCH_MODEL: ModelChoice = "sonnet";

/** Output token cap for the research reply (the JSON + its reasoning). */
const RESEARCH_MAX_TOKENS = 3072;

/**
 * TBSI blend weights — applied over WHICHEVER signals are present and then
 * re-normalized, so a film with critics-only still scores. Phase 1: buzz is a
 * minor review-sentiment nudge only; hard buzz metrics (YouTube/Trends/Reddit)
 * are Phase 2, so BUZZ_WEIGHT is deliberately small.
 */
export const CRITIC_WEIGHT = 0.55;
export const AUDIENCE_WEIGHT = 0.35;
export const BUZZ_WEIGHT = 0.10;

/** Verdict thresholds on the 0-10 TBSI score. */
export const MUST_WATCH_MIN = 8.0;
export const WORTH_TRY_MIN = 6.0;

/** Explicit critic scores required (with audience present) for a 'high' read. */
export const MIN_CRITICS_FOR_FIRM = 2;

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
  /** 0-10 audience signal REUSED from the film's aggregator data (IMDb). Not re-fetched. */
  audienceScore: number | null;
  /** Short qualitative chatter note only (hard buzz metrics are Phase 2). */
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

const WEB_SEARCH_TOOL: Anthropic.Messages.ToolUnion = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: MAX_SEARCHES_PER_FILM,
};

// ──────────────────────────────────────────────────────────────────────────
// Deterministic scoring — PURE, no API, unit-testable.
// ──────────────────────────────────────────────────────────────────────────

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Turn the found critic ratings + the reused audience score into a grounded
 * TBSI score, ★/5, verdict, and confidence. PURE function.
 *
 * - criticConsensus (0-10): mean of each rating's explicit/5 (×2) when the
 *   outlet published one, else its sentiment/5 (×2).
 * - buzz nudge (0-10): mean review SENTIMENT (×2) — Phase 1's minor tone nudge.
 * - tbsiScore: weighted blend (CRITIC/AUDIENCE/BUZZ) over the signals present,
 *   re-normalized; star = tbsiScore / 2.
 * - verdict by threshold; confidence by how much real signal exists.
 * - GATE: confidence 'none' → tbsiScore/star/verdict all null (the no-score
 *   path). 'none' triggers on found:false OR zero critic ratings — we never
 *   issue a score with no critic grounding (audience alone is not enough).
 */
export function computeVerdictScore(
  research: { found: boolean; criticRatings: CriticRating[] },
  audienceScore: number | null
): { tbsiScore: number | null; star: number | null; verdict: GroundedVerdict | null; confidence: Confidence } {
  const ratings = research.criticRatings;
  const explicitCount = ratings.filter(r => r.explicitScore !== null).length;

  // Confidence first — it gates whether we publish any score.
  let confidence: Confidence;
  if (!research.found || ratings.length === 0) {
    confidence = "none";
  } else if (explicitCount >= MIN_CRITICS_FOR_FIRM && audienceScore !== null) {
    confidence = "high";
  } else if (explicitCount >= 1 || ratings.length >= 2) {
    confidence = "medium";
  } else {
    confidence = "low"; // a single review, sentiment only — an early read
  }

  if (confidence === "none") {
    return { tbsiScore: null, star: null, verdict: null, confidence: "none" };
  }

  const criticConsensus = mean(
    ratings.map(r => (r.explicitScore !== null ? r.explicitScore : r.sentimentScore) * 2)
  );
  const buzzSentiment = mean(ratings.map(r => r.sentimentScore * 2));

  const signals: { w: number; v: number }[] = [
    { w: CRITIC_WEIGHT, v: criticConsensus },
    ...(audienceScore !== null ? [{ w: AUDIENCE_WEIGHT, v: audienceScore }] : []),
    { w: BUZZ_WEIGHT, v: buzzSentiment },
  ];
  const weightSum = signals.reduce((a, s) => a + s.w, 0);
  const tbsiScore = round1(signals.reduce((a, s) => a + s.w * s.v, 0) / weightSum);
  const star = round1(tbsiScore / 2);
  const verdict: GroundedVerdict =
    tbsiScore >= MUST_WATCH_MIN ? "Must Watch" : tbsiScore >= WORTH_TRY_MIN ? "Worth a Try" : "Skip";

  return { tbsiScore, star, verdict, confidence };
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

function assembleResearch(r: ResearchResponse, audienceScore: number | null): VerdictResearch {
  const scored = computeVerdictScore({ found: r.found, criticRatings: r.criticRatings }, audienceScore);
  return {
    found: r.found,
    criticRatings: r.criticRatings,
    audienceScore,
    buzzNote: r.buzzNote,
    tbsiScore: scored.tbsiScore,
    star: scored.star,
    verdict: scored.verdict,
    confidence: scored.confidence,
    summaryLine: r.summaryLine,
    theRead: r.theRead,
    watchIf: r.watchIf,
    sources: r.sources,
  };
}

/**
 * Interpret a raw research reply (text from the model) into a VerdictResearch:
 * parse → validate → deterministic score. Returns null if the reply can't be
 * parsed/validated. Exposed so the transport (API web_search vs CLI) can be
 * swapped in tests without touching the honesty/scoring logic.
 */
export function interpretResearchReply(raw: string, audienceScore: number | null): VerdictResearch | null {
  const parsed = parseResearchResponse(raw);
  return parsed ? assembleResearch(parsed, audienceScore) : null;
}

/** Honest "nothing found" result — the NO SCORE YET path, no fabricated verdict. */
export function notFound(audienceScore: number | null): VerdictResearch {
  return {
    found: false,
    criticRatings: [],
    audienceScore,
    buzzNote: "",
    tbsiScore: null,
    star: null,
    verdict: null,
    confidence: "none",
    summaryLine: "",
    theRead: "",
    watchIf: "",
    sources: [],
  };
}

/**
 * Research ONE film via web search and return a grounded VerdictResearch.
 * Billed Anthropic call (web search). On an unparseable/invalid reply it retries
 * ONCE, then degrades to notFound() — never throws into the job, never fabricates.
 */
export async function researchVerdict(film: Release): Promise<VerdictResearch> {
  // Audience signal is REUSED from the aggregator (IMDb) — never re-fetched here.
  const audienceScore = typeof film.imdbRating === "number" ? film.imdbRating : null;
  const year = (film.releaseDate ?? "").slice(0, 4);
  const basePrompt = buildResearchPrompt(film, year);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? basePrompt
      : `${basePrompt}\n\nYour previous reply was not valid JSON matching the required shape. Respond with ONLY the strict JSON object — no prose, no code fences.`;
    try {
      const raw = await callClaude(prompt, RESEARCH_MODEL, {
        tools: [WEB_SEARCH_TOOL],
        maxTokens: RESEARCH_MAX_TOKENS,
      });
      const parsed = parseResearchResponse(raw);
      if (parsed) return assembleResearch(parsed, audienceScore);
      log.warn(`researchVerdict(${film.title}): attempt ${attempt} — unparseable/invalid reply`);
    } catch (err) {
      log.warn(
        `researchVerdict(${film.title}): attempt ${attempt} errored — ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return notFound(audienceScore);
}
