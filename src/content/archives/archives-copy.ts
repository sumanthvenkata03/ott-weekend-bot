// src/content/archives/archives-copy.ts
// The ONE LLM call in the Archives pillar (ruling: one copy call max). It writes
// a single why-line per card — a reason to press play TONIGHT, not a synopsis —
// and, for a treasure card, a then-vs-now line. Every line is NAME-SWEPT by the
// live copy-guard: a name not backed by that film's own cast/crew data trips one
// retry, then falls back to a deterministic, name-free line for that card. No
// name a machine can't vouch for ever reaches a card.

import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { ArchivesKind } from "./archives-ledger.js";
import { buildArchivesNameAllowlist, sweepNames, type NameAllowlist } from "./copy-guard.js";

export interface ArchivesCopyInput {
  release: Release;
  kind: ArchivesKind;
  primaryGenre?: string;
}

export interface ArchivesCopy {
  /** title → the vetted why-line the card renders. */
  whyByTitle: Map<string, string>;
  /** Copy-guard flags that survived one retry (fell back to a safe line). */
  nameFlags: string[];
}

const WhyLineSchema = z.object({
  title: z.string(),
  why: z.string(),
});
const ArchivesCopySchema = z.object({
  whyLines: z.array(WhyLineSchema),
});
type LLMOutput = z.infer<typeof ArchivesCopySchema>;

function yearOf(r: Release): string {
  return r.releaseDate?.slice(0, 4) || "—";
}

/** Deterministic, name-free fallback line — honest metadata only, never a name. */
function safeWhyLine(c: ArchivesCopyInput): string {
  const genre = (c.primaryGenre ?? c.release.genre[0] ?? "film").toLowerCase();
  const yr = yearOf(c.release);
  const treasure = c.kind === "treasure";
  return treasure
    ? `Overlooked in ${yr}, this ${c.release.language} ${genre} plays far better tonight than it did on release.`
    : `A ${yr} ${c.release.language} ${genre} that has aged into a quiet must-watch.`;
}

function filmBlock(c: ArchivesCopyInput, i: number): string {
  const r = c.release;
  const lines = [
    `--- FILM ${i + 1} ---`,
    `Title: ${r.title}`,
    `Language: ${r.language}`,
    `Year: ${yearOf(r)}`,
    `Primary genre: ${c.primaryGenre ?? r.genre[0] ?? "—"}`,
    `All genres: ${r.genre.join(", ") || "—"}`,
    `Director: ${r.director ?? "—"}`,
    `Lead cast: ${(r.leadCast && r.leadCast.length ? r.leadCast : r.cast).slice(0, 3).join(", ") || "—"}`,
    `Streaming tonight on: ${r.platform[0] ?? "—"}`,
    `IMDb: ${r.imdbRating ?? "—"} (${r.imdbVotes ?? 0} votes)`,
    c.kind === "treasure" ? `TREASURE CARD: this film flopped/was overlooked on release and is loved now — write a THEN-vs-NOW line.` : "",
    `Synopsis: ${r.synopsis || "—"}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function buildPrompt(cards: ArchivesCopyInput[]): string {
  const blocks = cards.map(filmBlock).join("\n\n");
  return `You are the editor of TBSI ARCHIVES — a weekly Instagram post that resurfaces OLDER Indian films (2+ years old) that are worth streaming TONIGHT. Every film below is already verified: it is highly rated, has real audience votes, and is streaming in India right now.

TASK: For EACH film, write ONE why-line — a single sentence (max ~18 words) that makes someone want to press play tonight. A reason to watch, an angle, a hook — NOT a plot summary, NOT a synopsis, NOT a rating claim.

VOICE: confident, editorial, warm. English-first with light natural Hinglish allowed. No AI-cliches ("dive into", "delve", "look no further", "buckle up"). Never generic.

NAME DISCIPLINE (hard rule): NEVER name a person (actor, director, composer) who is NOT in that film's provided "Director" or "Lead cast". Do not recall a star from memory. If unsure who is in it, describe it WITHOUT naming anyone. Spell any name you DO use EXACTLY as provided.

For a TREASURE CARD, make the line THEN-vs-NOW: it under-performed / was missed on release, and it lands far better today.

FILMS:

${blocks}

Respond as JSON:
{
  "whyLines": [
    { "title": "<exact film title as given>", "why": "<one why-line>" }
  ]
}
Return exactly one entry per film, titles matching the input EXACTLY.`;
}

/** Map the LLM output to title→why, vetting each line through the name-sweep. */
function collectClean(
  output: LLMOutput,
  cards: ArchivesCopyInput[],
  allow: NameAllowlist
): { clean: Map<string, string>; dirty: Array<{ title: string; names: string[] }> } {
  const byTitle = new Map(output.whyLines.map((w) => [w.title, w.why]));
  const clean = new Map<string, string>();
  const dirty: Array<{ title: string; names: string[] }> = [];
  for (const c of cards) {
    const why = byTitle.get(c.release.title);
    if (!why) continue; // handled by caller (fallback)
    const names = sweepNames(why, allow);
    if (names.length > 0) dirty.push({ title: c.release.title, names });
    else clean.set(c.release.title, why);
  }
  return { clean, dirty };
}

/**
 * Generate + vet the deck's why-lines in ONE LLM call (plus at most one retry
 * naming the offending names). Any title still dirty after the retry, or missing
 * from the model's output, falls back to a deterministic name-free line — the
 * card still ships, honestly.
 */
export async function generateArchivesCopy(cards: ArchivesCopyInput[]): Promise<ArchivesCopy> {
  const nameFlags: string[] = [];
  if (cards.length === 0) return { whyByTitle: new Map(), nameFlags };

  const allow = buildArchivesNameAllowlist(cards.map((c) => c.release));
  const prompt = buildPrompt(cards);

  log.info(`Archives copy: one LLM call for ${cards.length} why-line(s)`);
  let output = await callClaudeJSON(prompt, ArchivesCopySchema, "opus");
  let { clean, dirty } = collectClean(output, cards, allow);

  if (dirty.length > 0) {
    const named = dirty.map((d) => `"${d.title}": ${d.names.map((n) => `"${n}"`).join(", ")}`).join("; ");
    log.warn(`Archives copy: name-discipline violation(s), retrying once — ${named}`);
    const retry =
      prompt +
      `\n\nNAME-DISCIPLINE VIOLATION — your previous reply named people NOT in the provided film data: ${named}. ` +
      `Regenerate EVERY why-line. Never name a person absent from that film's Director/Lead cast, and spell provided names exactly.`;
    output = await callClaudeJSON(retry, ArchivesCopySchema, "opus");
    ({ clean, dirty } = collectClean(output, cards, allow));
  }

  const whyByTitle = new Map<string, string>();
  for (const c of cards) {
    const why = clean.get(c.release.title);
    if (why) {
      whyByTitle.set(c.release.title, why);
    } else {
      whyByTitle.set(c.release.title, safeWhyLine(c));
      const stillDirty = dirty.find((d) => d.title === c.release.title);
      nameFlags.push(
        stillDirty
          ? `copy name-discipline: ${stillDirty.names.map((n) => `"${n}"`).join(", ")} not in film data on "${c.release.title}" — fell back to a safe line`
          : `copy: no why-line returned for "${c.release.title}" — fell back to a safe line`
      );
    }
  }

  return { whyByTitle, nameFlags };
}
