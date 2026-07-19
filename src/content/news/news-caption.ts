// src/content/news/news-caption.ts
// NEWS DESK · F (Phase 2) — the SWEPT caption + the post package.
//
// The UNSWEPT label is GONE. Its prerequisite — the shared name sweep — now
// exists (src/shared/copy-guard.ts), and this module runs it: a drafted caption
// is swept against its own stories' text (ruling R5), and an unbacked name
// forces ONE retry naming the offenders, exactly like Wed Drop's guard. A
// caption that fails twice is HELD, never shipped.
//
// The package is everything the owner needs to post by hand: caption, hashtag
// split (6 in caption / rest in first comment, per the standing 30-law), the
// badge-check mention board (§3 law 7 — NO TICK, NO TAG: names and candidate
// handles, never auto-tagged), and pinned-comment text.

import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import { sweepCaption } from "./news-sweep.js";
import type { ComposedEdition, SelectedStory } from "./news-compose.js";
import type { VerifiedStory } from "./news-verify.js";

/** Hashtags shown in the caption; the rest go to the first comment. */
export const CAPTION_HASHTAGS = 6;
/** Instagram's hard cap across caption + comments. */
export const MAX_HASHTAGS = 30;

const CaptionSchema = z.object({
  caption: z.string(),
  /** Every person the model named — cross-checked against the sweep. */
  namesUsed: z.array(z.string()).default([]),
  /** Handles it believes exist. NEVER auto-tagged; they go to the badge board. */
  mentionCandidates: z.array(z.string()).default([]),
});

export interface NewsPackage {
  caption: string;
  captionHashtags: string[];
  commentHashtags: string[];
  /** §3 law 7 — for MANUAL verification. No tick, no tag. */
  badgeCheckBoard: { name: string; candidateHandle: string | null }[];
  pinnedComment: string;
  /** Non-empty ⇒ the caption was HELD; the strings are the unbacked names. */
  heldFor: string[];
}

/** Unicode-bold a headline's letters/digits (IG has no rich text). */
export function unicodeBold(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 65 && c <= 90) out += String.fromCodePoint(0x1d5d4 + (c - 65));
    else if (c >= 97 && c <= 122) out += String.fromCodePoint(0x1d5ee + (c - 97));
    else if (c >= 48 && c <= 57) out += String.fromCodePoint(0x1d7ec + (c - 48));
    else out += ch;
  }
  return out;
}

/** Base hashtags + per-story language/segment tags, deduped, capped at 30. */
export function buildHashtags(edition: ComposedEdition): string[] {
  const tags: string[] = ["#TBSI", "#TheBigScreenIndex", "#IndianCinema"];
  const seg = edition.cover?.segment ?? edition.cards[0]?.segment;
  if (seg) tags.push(`#${seg.badge.replace(/[^A-Za-z]/g, "")}`);
  for (const c of edition.cards) {
    const lang = c.resolved.story.cluster.language;
    if (lang) tags.push(`#${lang}Cinema`);
    const film = c.resolved.film?.title;
    if (film) tags.push("#" + film.replace(/[^A-Za-z0-9]/g, ""));
  }
  tags.push("#OTT", "#OTTRelease", "#MovieNews", "#FilmNews", "#NowStreaming", "#SouthCinema");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const k = t.toLowerCase();
    if (t.length <= 1 || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

function storyLines(stories: SelectedStory[]): string {
  return stories
    .map((s, i) => {
      const c = s.resolved.story.cluster;
      return (
        `${i + 1}. ${c.headline}\n` +
        `   outlets: ${c.outlets.join(", ")}\n` +
        `   verified: ${s.resolved.story.basis}\n` +
        `   source: ${s.resolved.story.sourceUrl}`
      );
    })
    .join("\n");
}

function buildPrompt(edition: ComposedEdition, istDate: string, retryFor?: string[]): string {
  const stories = edition.cover ? [edition.cover, ...edition.cards.filter((c) => c !== edition.cover)] : edition.cards;
  const seg = stories[0]!.segment;

  let p = `Write an Instagram caption for @thebigscreenindex, an Indian cinema editorial page whose brand is ACCURACY.

DATE: ${istDate}
SEGMENT: ${seg.badge}
FORMAT: ${edition.format}

CONFIRMED STORIES — these are the ONLY facts you may use:
${storyLines(stories)}

STRUCTURE:
1. A headline line (I will apply unicode-bold — write it in plain text).
2. One short paragraph per story, in order.
3. A CTA question to the reader.
4. A share line.
5. This exact sign-off on its own last line: ${seg.signoff}

HARD RULES — these are editorial law, not style:
- NAME THE SOURCE for every fact: "confirmed by X", "per Y". A fact with no named source may not appear.
- ESTIMATES LAW: every trade/box-office figure is an estimate. Write "an estimated ₹X crore" — never a bare figure stated as settled fact.
- NO superlatives. Never "biggest", "huge", "stunning", "must-see", "shocking", "historic".
- NO fact that is not in the list above. Do not add context you remember.
- NAMES: prefer a person's FULL name. If a source printed only a short form, keep the source's form — do not expand it from memory, and do not invent a surname.
- Do not speculate about what a story means or what comes next.
- Under 150 words total.

Also return:
- "namesUsed": every person you named.
- "mentionCandidates": @handles you believe exist for those people (these are NEVER auto-tagged — a human verifies each).`;

  if (retryFor?.length) {
    p +=
      `\n\nNAME-DISCIPLINE VIOLATION — your previous caption named ` +
      `${retryFor.map((n) => `"${n}"`).join(", ")}, which does NOT appear anywhere in the story ` +
      `headlines, verification notes, or outlet names above. Regenerate the ENTIRE caption and ` +
      `name only people the sources themselves printed.`;
  }
  return p;
}

/**
 * Draft + sweep the caption, then assemble the package. ONE retry on a sweep
 * violation; a second failure HOLDS the caption (heldFor non-empty) rather than
 * shipping an unbacked name.
 */
export async function buildPackage(
  edition: ComposedEdition,
  istDate: string
): Promise<NewsPackage> {
  const hashtags = buildHashtags(edition);
  const empty: NewsPackage = {
    caption: "",
    captionHashtags: hashtags.slice(0, CAPTION_HASHTAGS),
    commentHashtags: hashtags.slice(CAPTION_HASHTAGS),
    badgeCheckBoard: [],
    pinnedComment: "",
    heldFor: [],
  };

  if (edition.format === "none") {
    return { ...empty, caption: "(no caption — no edition today)" };
  }

  const stories: VerifiedStory[] = [
    ...(edition.cover ? [edition.cover.resolved.story] : []),
    ...edition.cards.map((c) => c.resolved.story),
  ];

  let out: z.infer<typeof CaptionSchema> | null = null;
  let violations: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      out = await callClaudeJSON(
        buildPrompt(edition, istDate, attempt === 1 ? violations : undefined),
        CaptionSchema,
        "opus"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Caption draft failed — ${msg}`);
      return { ...empty, caption: `(caption unavailable — ${msg})` };
    }
    violations = sweepCaption(out.caption, stories);
    if (violations.length === 0) break;
    log.warn(`  Caption name sweep flagged: ${violations.join(", ")}${attempt === 0 ? " — retrying once" : " — HELD"}`);
  }

  if (!out) return empty;
  if (violations.length > 0) {
    return { ...empty, caption: "(caption HELD — unbacked names)", heldFor: violations };
  }

  // Bold the first line — the headline.
  const lines = out.caption.trim().split("\n");
  const caption = [unicodeBold(lines[0] ?? ""), ...lines.slice(1)].join("\n");

  const board = out.namesUsed.map((name) => {
    const cand = out!.mentionCandidates.find((h) =>
      h.toLowerCase().replace(/[^a-z]/g, "").includes(name.toLowerCase().split(" ")[0] ?? "~")
    );
    return { name, candidateHandle: cand ?? null };
  });

  const pinned =
    `Sources: ` +
    stories.map((s) => `${s.cluster.outlets[0] ?? "source"} — ${s.sourceUrl}`).join(" · ") +
    `\nFigures are estimates where stated. Corrections go here.`;

  return {
    caption,
    captionHashtags: hashtags.slice(0, CAPTION_HASHTAGS),
    commentHashtags: hashtags.slice(CAPTION_HASHTAGS),
    badgeCheckBoard: board,
    pinnedComment: pinned,
    heldFor: [],
  };
}
