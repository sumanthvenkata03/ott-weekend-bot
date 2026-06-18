// src/content/weekend/thursday-compare.ts
import { format, parseISO } from "date-fns";
import { z } from "zod";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { CompareDraft } from "../../delivery/notion.js";

// Compare reel: a fixed single-object shape (no array-count contract — the A/B
// beat lists are soft-guided in the prompt, so they're validated as string arrays
// without a strict length to avoid false retries). All fields required.
const ThursdayCompareSchema = z.object({
  caption: z.string(),
  hashtags: z.array(z.string()),
  pinnedCommentSeed: z.string(),
  reelScript: z.object({
    hook: z.string(),
    filmABeats: z.array(z.string()),
    filmBBeats: z.array(z.string()),
    decidingLine: z.string(),
    cta: z.string(),
    onScreenText: z.array(z.string()),
    visualDirection: z.string(),
    suggestedAudioMood: z.string(),
    coverFrameText: z.string(),
  }),
});

type LLMOutput = z.infer<typeof ThursdayCompareSchema>;

function releaseForPrompt(r: Release, label: "A" | "B"): string {
  return [
    `=== FILM ${label} ===`,
    `Title: ${r.title}`,
    `Language: ${r.language}`,
    `Release date: ${r.releaseDate}`,
    `Genres: ${r.genre.join(", ") || "—"}`,
    `Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `Director: ${r.director ?? "—"}`,
    `Cast: ${r.cast.slice(0, 4).join(", ") || "—"}`,
    `Runtime: ${r.runtime ? `${r.runtime} min` : "—"}`,
    r.imdbRating ? `IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "IMDb: not yet rated",
    `Synopsis: ${r.synopsis}`,
  ].join("\n");
}

export async function generateThursdayCompare(
  filmA: Release,
  filmB: Release,
  weekendStart: string,
  weekendEnd: string
): Promise<CompareDraft> {
  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  log.info(`Generating Thursday Compare: ${filmA.title} vs ${filmB.title}`);
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. Thursday is the FACE-OFF reel — two films, one Friday, force a choice.

PAGE IDENTITY:
- Pan-Indian, South-heavy. We don't avoid taking sides.
- Confident, opinionated, conversational. Light Hinglish where natural.
- Thu Compare is our ENGAGEMENT pillar. Comments are the goal — people defend their pick.

CRITICAL TONE RULES:
- Both films get FAIR specific framing. Don't crown a winner — let viewers decide. The DECIDING LINE tells them how to pick based on what they want.
- Be specific to each film. NOT "great performances" — "Allu Arjun's quietest moment of his career" or whatever the film actually offers.
- Each beat must be a real, distinguishing feature of that film. NO generic praise that could apply to either.
- The pinned comment seed should be a HOT TAKE — bias one way deliberately. Reel stays neutral, pinned comment is your editorial position. That tension drives replies.
- NEVER use AI clichés: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "elevates", "landscape".

WEEKEND: ${weekendDates}

${releaseForPrompt(filmA, "A")}

${releaseForPrompt(filmB, "B")}

DELIVERABLES (respond as JSON):

{
  "caption": "Under 100 words. Open with the face-off framing ('Two films. One Friday. Pick your weekend.'). One sentence each about A and B. End with 'Comment your pick. We'll DM you where to stream it.'",
  "hashtags": ["10 hashtags array, with # prefix. Include both language tags, both platform tags (if known), and the broad ones."],
  "pinnedCommentSeed": "Under 220 chars. A controversial-but-defensible take that picks ONE film over the other, with a specific reason. The kind of comment that triggers replies from fans of the other film. NOT 'they're both great' — pick a side.",
  "reelScript": {
    "hook": "0–2 sec voiceover. Splits the screen visually + asks the question. e.g., 'Two big drops. One Friday. Which one are you watching?'",
    "filmABeats": ["Three quick voiceover lines for Film A (2-8 sec total). Each names a SPECIFIC strength — director's signature move, an actor's known register, a structural choice. Each 5-12 words. NO generic praise."],
    "filmBBeats": ["Three quick voiceover lines for Film B (8-14 sec total). Same rules as A."],
    "decidingLine": "14–18 sec voiceover. THE post's spine. Format: 'Watch [A] if you want [X mood/experience], [B] if you want [Y mood/experience].' Make X and Y specific moods/states/genres — NOT 'fun' vs 'serious'.",
    "cta": "18–20 sec voiceover. 'Comment your pick. We'll DM you where to stream it.' or sharper variant.",
    "onScreenText": ["4 text overlay frames, max 6 words each. e.g., 'TWO BIG DROPS', '[FILM A NAME]', '[FILM B NAME]', 'PICK YOUR FRIDAY'"],
    "visualDirection": "Shot list for the editor. Split-screen frame for hook. Each film's beats use Pexels-friendly B-roll cues (city night, neon, festival lights, rain on asphalt — never copyrighted film clips). Describe the color treatment that distinguishes the two halves visually.",
    "suggestedAudioMood": "calm | energetic | dramatic | tense | upbeat — pick one based on the films' combined energy. This helps the editor find a trending audio track.",
    "coverFrameText": "The bold text that appears in the IG grid thumbnail. Max 4 words. e.g., 'PICK YOUR FRIDAY' or 'HINDI vs MALAYALAM'."
  }
}

IMPORTANT:
- If either film has no IMDb rating, you can still make specific claims based on director history, cast, genre, synopsis. Be confident — don't hedge with "if it delivers" unless absolutely warranted.
- The deciding line is the post's spine. Spend the most thinking budget there.
- Pinned comment must take a side. Neutrality on a Thu Compare is content failure.`;
  
  const output = await callClaudeJSON(prompt, ThursdayCompareSchema, "opus");
  
  return {
    pillar: "Thu Compare",
    weekendDates,
    filmA,
    filmB,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    pinnedCommentSeed: output.pinnedCommentSeed,
    reelScript: output.reelScript,
  };
}