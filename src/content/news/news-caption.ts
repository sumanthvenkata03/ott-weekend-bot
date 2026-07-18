// src/content/news/news-caption.ts
// NEWS DESK · F — the draft caption. ONE Claude CLI copy call per run.
//
// ⚠️ LAW N3 — the output of this module is an UNSWEPT DRAFT. The shared
// name-sweep extraction (the pass that catches unverified person/film names
// slipping into published copy) is a DECLARED PREREQUISITE of Phase 2, and does
// not exist yet. Nothing this module produces may be posted. The label travels
// WITH the text, in the returned value — not merely in the Slack formatting —
// so it cannot be lost by a future caller that reformats the draft.
//
// The prompt hard-constrains the two things a news caption gets wrong: inventing
// emphasis (superlatives) and inventing facts. Only confirmed stories are passed
// in, every source is named, and the model is told it may not add a fact.

import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { ComposedEdition } from "./news-compose.js";

/** Prepended to every draft caption. N3 made structural, not cosmetic. */
export const UNSWEPT_LABEL = "[UNSWEPT DRAFT — name-sweep is a Phase-2 prerequisite; not for posting]";

const CaptionSchema = z.object({
  caption: z.string(),
});

function buildPrompt(edition: ComposedEdition, istDate: string): string {
  const stories = [edition.cover, ...edition.cards]
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map(
      (s, i) =>
        `${i + 1}. ${s.cluster.headline}\n   outlets: ${s.cluster.outlets.join(", ")}\n   verified basis: ${s.basis}\n   source: ${s.sourceUrl}`
    )
    .join("\n");

  return `Draft an Instagram caption for a film-news post from an Indian OTT editorial account.

DATE: ${istDate}
FORMAT: ${edition.format}

CONFIRMED STORIES (these are the ONLY facts you may use):
${stories}

VOICE: plain, calm, factual. A wire desk that respects the reader. Short sentences.

HARD RULES:
- NO superlatives. Never "biggest", "huge", "stunning", "must-see", "shocking".
- NO fact that is not in the list above. You may not add context you remember.
- NAME the outlet for each story ("per The Hindu", "Cinema Express reports").
- No hype punctuation. No emoji spam — at most one, and only if it earns its place.
- Do not speculate about what a story means or what happens next.
- Keep it under 120 words.

Return JSON: {"caption":"..."}`;
}

/**
 * Draft the caption. Returns the UNSWEPT-labelled text. A failure degrades to a
 * stated placeholder rather than throwing — the Slack draft (scores, sources,
 * held list) is still worth sending without copy, and a missing caption is
 * obvious where a half-generated one is not.
 */
export async function draftCaption(
  edition: ComposedEdition,
  istDate: string
): Promise<string> {
  if (edition.format === "NONE") {
    return `${UNSWEPT_LABEL}\n(no caption — no edition today)`;
  }
  try {
    const out = await callClaudeJSON(buildPrompt(edition, istDate), CaptionSchema, "opus");
    return `${UNSWEPT_LABEL}\n${out.caption.trim()}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`  Caption draft failed — ${msg}`);
    return `${UNSWEPT_LABEL}\n(caption unavailable — ${msg})`;
  }
}
