// src/content/weekend/saturday-verdict.ts
// Phase 1 (grounded Verdicts): per-film verdicts/tiers/copy are now produced by
// verdict-research.ts (real review aggregation). This module is SLIM — it only
// writes the cover editorial (caption + hashtags + hot-take), and it is FED the
// already-decided grounded calls so the cover matches them. It never decides a
// verdict and never invents a per-film judgement.

import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";

/** Format a window (startDate, endDate ISO) into the cover's date-range label. */
export function formatWindowDates(weekendStart: string, weekendEnd: string): string {
  return `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
}

/** One grounded, already-selected film handed to the cover writer (read-only). */
export interface GroundedCoverFilm {
  filmTitle: string;
  language: string;
  /** Emoji verdict string, already decided by research — must NOT be changed. */
  verdict: string;
  /** Grounded ★/5 (1dp) if scored, else null. */
  star: number | null;
  /** Grounded one-line verdict from research. */
  summaryLine: string;
}

const CoverSchema = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()),
  hotTake: z.string(),
});

export interface VerdictCover {
  caption: string;
  hashtags: string;
  hotTake: string;
}

/**
 * Write ONLY the cover editorial for the Verdict carousel, fed the grounded
 * per-film calls (verdict + ★ + one-liner). The copy must MATCH those calls —
 * the model does not re-judge anything here.
 */
export async function generateVerdictCover(
  films: GroundedCoverFilm[],
  weekendStart: string,
  weekendEnd: string
): Promise<VerdictCover> {
  if (films.length === 0) {
    throw new Error("Cannot generate Verdict cover with zero films");
  }

  const weekendDates = formatWindowDates(weekendStart, weekendEnd);
  log.info(`Generating Verdict cover for ${weekendDates} (${films.length} grounded films)`);

  const filmBlocks = films
    .map((f, i) => {
      const star = f.star !== null ? `★${f.star.toFixed(1)}/5` : "no firm score";
      return `${i + 1}. ${f.verdict} — ${f.filmTitle} (${f.language}) · ${star}\n   "${f.summaryLine}"`;
    })
    .join("\n");

  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. We give VERDICTS, not vibes.

PAGE IDENTITY:
- Decision page, not info page. We tell people what to watch, what to skip, and why.
- Pan-Indian coverage with South-heavy weighting where the films justify it.
- Confident, opinionated, conversational — like a friend texting recommendations.
- Light Hinglish where natural ("skip kar do", "weekend sorted", "kya scene hai").

CRITICAL TONE RULES:
- NEVER hedge. Take stands. "Skip" is a valid call.
- "🎟️ One-Time Watch" is a real call: worth a single watch but not a keeper — present it as "good for one spin", do NOT flatten it into a Skip or inflate it into a rec.
- Acknowledge weaknesses even on the strong picks. Audiences trust honest critics.

NEVER use these AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "without further ado", "elevates".

TASK: Write ONLY the cover editorial for this week's "The Verdict" carousel.

RELEASE WINDOW (Wed → Fri): ${weekendDates}

THESE VERDICTS ARE ALREADY DECIDED from real critic reviews — DO NOT change, soften, or upgrade any of them. Your copy must MATCH these calls exactly:

${filmBlocks}

DELIVERABLES (respond as JSON):

{
  "caption": "Under 130 words. OPENS with the boldest verdict of the week as a hook (lead with whichever call above is strongest/most surprising). Reflect the actual calls above. End with 'Save this before you press play' or similar CTA.",
  "hashtags": ["10 hashtags array with # prefix"],
  "hotTake": "One pinnable bold opinion that MATCHES the calls above — controversial but defensible, the kind of comment that triggers replies. HARD LIMIT: a COMPLETE single thought UNDER 140 characters (it prints in full on the cover; longer gets cut mid-sentence). Frame it as THIS WEEK'S slate (the window runs Wed–Fri) — do NOT call it 'the weekend'. Example: 'Mollywood made a better political thriller this week than Hindi cinema has all year.'"
}

RULES:
- Do NOT contradict the verdicts above. If the top call is a Skip, the hook can still be bold ("Nothing's a Must Watch this week — here's the one worth a try.").
- Reference real titles from the list. Do not invent films, ratings, or quotes.`;

  const output = await callClaudeJSON(prompt, CoverSchema, "opus");

  return {
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    hotTake: output.hotTake,
  };
}
