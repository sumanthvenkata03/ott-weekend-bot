// src/research/consolidate.ts
// Step 3: the ONE LLM-powered step. Turns a ResearchResult (raw multi-source
// data) into a clean, provenance-tagged ConsolidatedResearch — facts vs signal,
// each field tagged with its source(s) + confidence. DATA ONLY: no caption, no
// editorial voice.
//
// Cost & honesty:
// - Runs on the Max-plan Claude Code CLI (callClaudeJSON) — Opus 4.8, webSearch
//   OFF, no API key. The model consolidates ONLY the provided sources; it must
//   not pull anything from its own training knowledge.
// - Result is cached per FILM IDENTITY (7d) so re-runs never re-bill quota.
// - This module is opt-in: the key-free `npm run research` CLI never imports it.
import { z } from "zod";
import { callClaudeJSON, MODELS } from "../content/claude.js";
import type { ModelChoice } from "../content/claude.js";
import { cached, db } from "../shared/cache.js";
import { log } from "../shared/logger.js";
import { researchFilm } from "./index.js";
import type {
  ConsolidatedFacts,
  ConsolidatedResearch,
  ConsolidatedSignal,
  DiscardedItem,
  ResearchQuery,
  ResearchResult,
  SourceKind,
  SourceName,
} from "./types.js";

// Facts are stable and signal moves slowly, so a generous TTL keeps re-runs of
// the same film free (a model call is Max-plan quota).
const CONSOLIDATE_TTL = 604800; // 7 days

export interface ConsolidateOptions {
  /** Model override; defaults to "opus" (Opus 4.8 — highest quality available). */
  model?: ModelChoice;
}

// ── Model-output schema ─────────────────────────────────────────────────────
// PERMISSIVE by design: every field inside facts/signal is .optional(). Sparse
// (overlooked) films legitimately omit most fields, and the prompt tells the
// model to omit what the sources don't support — a required field would make a
// correctly-omitted value fail validation and (after one retry) throw.
const SOURCE_NAMES = ["wikipedia", "googleNews", "reddit", "youtube", "brave", "tavily"] as const;
const SourceNameSchema = z.enum(SOURCE_NAMES);
const ConfidenceSchema = z.enum(["high", "medium", "low"]);

function fieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    sources: z.array(SourceNameSchema),
    confidence: ConfidenceSchema,
    note: z.string().optional(),
  });
}

const FactsSchema = z.object({
  title: fieldSchema(z.string()).optional(),
  year: fieldSchema(z.number()).optional(),
  languages: fieldSchema(z.array(z.string())).optional(),
  director: fieldSchema(z.string()).optional(),
  cast: fieldSchema(z.array(z.string())).optional(),
  musicDirector: fieldSchema(z.string()).optional(),
  releaseDate: fieldSchema(z.string()).optional(),
  runtime: fieldSchema(z.string()).optional(),
  genres: fieldSchema(z.array(z.string())).optional(),
  synopsis: fieldSchema(z.string()).optional(),
  boxOffice: fieldSchema(z.string()).optional(),
});

const SignalSchema = z.object({
  criticalReception: fieldSchema(z.string()).optional(),
  audienceBuzz: fieldSchema(z.string()).optional(),
  discoverability: fieldSchema(z.string()).optional(),
  controversies: fieldSchema(z.string()).optional(),
  notes: fieldSchema(z.array(z.string())).optional(),
});

const DiscardedSchema = z.object({
  title: z.string().optional(),
  url: z.string().optional(),
  source: SourceNameSchema,
  reason: z.string(),
});

const ModelOutputSchema = z.object({
  facts: FactsSchema,
  signal: SignalSchema,
  discarded: z.array(DiscardedSchema).default([]),
});

// ── Prompt projection ───────────────────────────────────────────────────────
interface ProjectedItem {
  title?: string;
  url?: string;
  snippet?: string;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}
interface ProjectedSource {
  source: SourceName;
  kind: SourceKind;
  ok: boolean;
  error?: string;
  meta?: Record<string, unknown>;
  items: ProjectedItem[];
}

/** Compact projection for the prompt: items + source-level meta, NO heavy raw. */
function projectForPrompt(research: ResearchResult): ProjectedSource[] {
  return research.results.map((r) => ({
    source: r.source,
    kind: r.kind,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
    ...(r.meta ? { meta: r.meta } : {}),
    items: r.items.map((it) => ({
      ...(it.title ? { title: it.title } : {}),
      ...(it.url ? { url: it.url } : {}),
      ...(it.snippet ? { snippet: it.snippet } : {}),
      ...(it.publishedAt ? { publishedAt: it.publishedAt } : {}),
      ...(it.meta ? { meta: it.meta } : {}),
    })),
  }));
}

function buildConsolidatePrompt(research: ResearchResult): string {
  const { title, year } = research.query;
  const sources = JSON.stringify(projectForPrompt(research), null, 2);
  return `You are a film-research consolidator for The Big Screen Index. You turn raw multi-source research about ONE film into a clean, structured, provenance-tagged data object. You output DATA ONLY.

#1 RULE — USE ONLY THE PROVIDED SOURCE DATA (this is the most important rule):
- Every value you output MUST come from the SOURCES block below. Do NOT add any fact from your own knowledge or memory, even if you are certain you know this film.
- If a fact is not present in the sources, OMIT that field entirely. Never guess, infer, estimate, average, or fill any value (runtime, box office, year, release date, cast, etc.) from memory.
- You have no web access and no other data. The SOURCES block is your ONLY ground truth. A value that cannot be traced to a provided source item is a failure.

FILM (the subject — identity only, NOT a source of facts):
- Title: ${title}
- Year: ${year ?? "unknown"}

SOURCES (the ONLY ground truth — JSON):
${sources}

TASK — separate FACTS from SIGNAL, both traceable to the sources:
- FACTS (objective/verifiable): title, year, languages, director, cast, musicDirector, releaseDate, runtime, genres, synopsis (a factual one-line plot summary — NOT a review), boxOffice. Include a field ONLY if a source supports it.
- SIGNAL (interpreted): criticalReception (summarize the consensus WITH its nuance — if reviews are mixed, say "mixed"; do NOT round up to "acclaimed"), audienceBuzz (chatter/anticipation), discoverability (widely seen vs overlooked — use evidence like YouTube trailer view counts and news volume), controversies (legal/plagiarism/etc., ONLY if in the sources), notes (other noteworthy signal, as a short list).

PROVENANCE + CONFIDENCE — for EVERY field you output:
- "sources": the array of source names supporting the value (e.g. ["wikipedia"] or ["googleNews","youtube"]). Use ONLY these names: wikipedia, googleNews, youtube, tavily.
- "confidence": "high" = authoritative source (Wikipedia/structured) OR multiple sources agree; "medium" = a single decent source; "low" = thin/indirect/conflicting.
- "note" (optional): a short caveat when data is thin or sources disagree.

CROSS-FILM FILTER (critical):
- Some items — especially news — may merely NAME-DROP this film while actually being about a DIFFERENT film, person, or topic (e.g. the director's other movie). Base facts/signal ONLY on items genuinely about "${title}".
- Put every excluded item in "discarded" with its source and a one-line reason. If nothing is excluded, return an empty array.

DO NOT:
- Do NOT write any caption, social copy, headline, brand-voice summary, "why you missed it" line, hashtags, or emojis. Output structured data only.
- Do NOT fabricate certainty. When data is thin or sources conflict, use low confidence and a short note — never invent a value to look complete.

OUTPUT — STRICT JSON ONLY (no markdown, no prose). Omit any field with no source support; every facts/signal field is optional:
{
  "facts": {
    "title": { "value": "...", "sources": ["wikipedia"], "confidence": "high", "note": "optional" },
    "year": { "value": 2024, "sources": ["wikipedia"], "confidence": "high" },
    "languages": { "value": ["Malayalam"], "sources": ["wikipedia"], "confidence": "high" },
    "director": { "value": "...", "sources": ["..."], "confidence": "..." },
    "cast": { "value": ["...", "..."], "sources": ["..."], "confidence": "..." },
    "musicDirector": { "value": "...", "sources": ["..."], "confidence": "..." },
    "releaseDate": { "value": "...", "sources": ["..."], "confidence": "..." },
    "runtime": { "value": "...", "sources": ["..."], "confidence": "..." },
    "genres": { "value": ["..."], "sources": ["..."], "confidence": "..." },
    "synopsis": { "value": "...", "sources": ["..."], "confidence": "..." },
    "boxOffice": { "value": "...", "sources": ["..."], "confidence": "..." }
  },
  "signal": {
    "criticalReception": { "value": "...", "sources": ["..."], "confidence": "..." },
    "audienceBuzz": { "value": "...", "sources": ["..."], "confidence": "..." },
    "discoverability": { "value": "...", "sources": ["..."], "confidence": "..." },
    "controversies": { "value": "...", "sources": ["..."], "confidence": "..." },
    "notes": { "value": ["..."], "sources": ["..."], "confidence": "..." }
  },
  "discarded": [ { "title": "...", "url": "...", "source": "googleNews", "reason": "..." } ]
}`;
}

// ── Cache (identity-keyed) ──────────────────────────────────────────────────
// cached() exposes no hit/miss, so we peek http_cache directly (same table +
// pattern as http.ts) to stamp `cached` fresh on each call.
const peekStmt = db.prepare("SELECT expires_at FROM http_cache WHERE key = ?");

function cacheKeyFor(q: ResearchQuery): string {
  if (q.imdbId) return `research:consolidate:${q.imdbId}`;
  return `research:consolidate:${q.title.toLowerCase()}:${q.year ?? ""}`;
}

function isFresh(key: string): boolean {
  const row = peekStmt.get(key) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

/** Count populated top-level fields (zod strips absent keys, so all present). */
function countFields(obj: object): number {
  return Object.values(obj).filter((v) => v !== undefined).length;
}

/**
 * Consolidate an already-fetched ResearchResult into structured, provenance-
 * tagged data. Cached per film identity (imdbId if present, else title:year);
 * a thrown model call caches nothing.
 */
export async function consolidate(
  research: ResearchResult,
  opts: ConsolidateOptions = {}
): Promise<ConsolidatedResearch> {
  const model: ModelChoice = opts.model ?? "opus";
  const { title, year } = research.query;
  const key = cacheKeyFor(research.query);
  const wasFresh = isFresh(key); // peek BEFORE cached() runs the loader

  const data = await cached<ConsolidatedResearch>(
    key,
    async () => {
      const prompt = buildConsolidatePrompt(research);
      const parsed = await callClaudeJSON(prompt, ModelOutputSchema, model);
      // exactOptionalPropertyTypes + zod's .optional() infers `T | undefined`
      // on each optional field, which won't assign to the pure `?: T`
      // interfaces. zod strips absent keys, so the validated data never holds
      // an explicit undefined — a narrow cast at this single boundary is safe.
      return {
        query: { title, ...(year !== undefined ? { year } : {}) },
        facts: parsed.facts as ConsolidatedFacts,
        signal: parsed.signal as ConsolidatedSignal,
        discarded: parsed.discarded as DiscardedItem[],
        model: MODELS[model],
        consolidatedAt: new Date().toISOString(),
      };
    },
    { ttlSeconds: CONSOLIDATE_TTL }
  );

  const result: ConsolidatedResearch = { ...data, cached: wasFresh };

  log.info(
    `consolidate '${title}' — ${countFields(result.facts)} facts, ` +
      `${countFields(result.signal)} signal, ${result.discarded.length} discarded, ` +
      `cached=${wasFresh}`
  );

  return result;
}

/** Convenience: fetch raw research for a film, then consolidate it. */
export async function consolidateFilm(
  title: string,
  year?: number,
  opts?: ConsolidateOptions
): Promise<ConsolidatedResearch> {
  const research = await researchFilm({ title, ...(year !== undefined ? { year } : {}) });
  return consolidate(research, opts);
}
