// src/content/weekend/saturday-verdict.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { SaturdayVerdictDraft, VerdictSlide } from "../../delivery/notion.js";

interface LLMOutput {
  caption: string;
  hashtags: string[];
  hotTake: string;
  verdicts: {
    filmTitle: string;
    language: string;
    platform: string[];
    verdict: "🔥 Must Watch" | "👀 Worth a Try" | "⏭️ Skip";
    oneLineVerdict: string;
    watchIf: string;
    skipIf: string;
    whereItWins: string;
    whereItLoses: string;
    watchSetup: string;
  }[];
}

function releaseForPrompt(r: Release): string {
  return [
    `Title: ${r.title}`,
    `Language: ${r.language}`,
    `Release date: ${r.releaseDate}`,
    `Genres: ${r.genre.join(", ") || "—"}`,
    `Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `Director: ${r.director ?? "—"}`,
    `Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`,
    `Runtime: ${r.runtime ? `${r.runtime} min` : "—"}`,
    r.imdbRating ? `IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "IMDb: not yet rated",
    `Synopsis: ${r.synopsis}`,
  ].join("\n");
}

export async function generateSaturdayVerdict(
  releases: Release[],
  weekendStart: string,
  weekendEnd: string
): Promise<SaturdayVerdictDraft> {
  if (releases.length === 0) {
    throw new Error("Cannot generate Saturday Verdict with zero releases");
  }
  
  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  log.info(`Generating Saturday Verdict for ${weekendDates} (${releases.length} releases)`);
  
  const releaseBlocks = releases
    .map((r, i) => `--- RELEASE ${i + 1} ---\n${releaseForPrompt(r)}`)
    .join("\n\n");
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. We give VERDICTS, not vibes.

PAGE IDENTITY:
- Decision page, not info page. We tell people what to watch, what to skip, and why.
- Pan-Indian coverage with South-heavy weighting where the films justify it
- Confident, opinionated, conversational — like a friend texting recommendations
- Light Hinglish where natural ("skip kar do", "weekend sorted", "kya scene hai")

CRITICAL TONE RULES:
- NEVER hedge. "It might be good" → "It's worth a swing — here's why."
- Take stands. If something doesn't deserve a watch, say so. "Skip" is a valid call.
- Acknowledge weaknesses even on Must Watches. Audiences trust honest critics.
- South-heavy: Malayalam, Tamil, Telugu, Kannada films get equal-or-greater weight than Hindi when the films are stronger.

NEVER use these AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "without further ado", "elevates".

TASK: Generate Saturday "The Verdict" Instagram carousel post.

WEEKEND: ${weekendDates}

RELEASES TO JUDGE (${releases.length}):

${releaseBlocks}

VERDICT SYSTEM:
- 🔥 Must Watch — clear recommendation, prioritize watching this
- 👀 Worth a Try — has flaws but the strengths earn a watch
- ⏭️ Skip — don't waste the runtime

DELIVERABLES (respond as JSON):

{
  "caption": "Under 130 words. OPENS with the boldest verdict of the week as a hook (e.g., 'Skip the Hindi blockbuster. Watch the Malayalam film instead.'). Acknowledge any controversial calls. End with 'Save this before you press play' or similar CTA.",
  "hashtags": ["10 hashtags array with # prefix"],
  "hotTake": "One pinnable bold opinion under 200 chars — controversial but defensible. The kind of comment that triggers replies. Example: 'Mollywood made a better political thriller this week than Hindi cinema has all year.'",
  "verdicts": [
    {
      "filmTitle": "<exact title from input>",
      "language": "<exact language from input>",
      "platform": ["<array from input — empty array if TBA>"],
      "verdict": "🔥 Must Watch | 👀 Worth a Try | ⏭️ Skip",
      "oneLineVerdict": "Max 12 words. Confident, specific, quotable. NOT 'A great film' — be specific.",
      "watchIf": "Watch if you liked [X film/genre]. Be specific — name an actual comparable film or director or trope.",
      "skipIf": "Skip if you're tired of [Y]. Name the actual fatigue point.",
      "whereItWins": "Single specific strength. NOT 'great performances' — 'the second-act twist that recontextualizes the whole opening' kind of specific.",
      "whereItLoses": "Single honest weakness. Even on Must Watches, find the trade-off.",
      "watchSetup": "When/how to watch. e.g., 'Saturday night, full attention, no phone' or 'Sunday afternoon, half-watching while doing laundry is fine.'"
    }
  ]
}

CARD COUNT — quality over coverage:
- Pick 3 to 5 films from the slate above. If only 3 are worth talking about, deliver 3. If 5 are, deliver 5.
- Do NOT pad with weak Skips just to fill cards. A tight 3-card carousel beats a bloated 6-card one.

VERDICT MIX — pick what the slate actually deserves:
- Strong weekend: 1-2 Must Watch + 1-2 Worth a Try + 1 Skip
- Average weekend: 1 Must Watch + 1-2 Worth a Try + 1-2 Skip
- Weak weekend: 0-1 Must Watch + 1 Worth a Try + 2-3 Skip
- Never deliver an all-Skip carousel. If the slate is that weak, deliver 1 Worth a Try (the least bad) + at most 2 Skips, OR return verdicts: [] and let the pillar skip this weekend entirely.

MUST WATCH RULE:
- At least one verdict MUST be 🔥 Must Watch IF any film legitimately qualifies. Don't withhold the call to seem balanced.
- If NOTHING qualifies as Must Watch this weekend, that's fine — but say so in the hotTake ("No Must Watch this weekend — here's the next best thing.").

OTHER:
- If a film has no IMDb rating yet (unreleased), make your call based on director track record, cast, genre, synopsis. Be specific about why.
- The "filmTitle", "language", "platform" fields must match the input exactly.`;
  
  const output = await callClaudeJSON<LLMOutput>(prompt, "opus");
  
  // Map output to typed VerdictSlide[]
  const verdicts: VerdictSlide[] = output.verdicts.map(v => ({
    filmTitle: v.filmTitle,
    language: v.language,
    platform: v.platform,
    verdict: v.verdict,
    oneLineVerdict: v.oneLineVerdict,
    watchIf: v.watchIf,
    skipIf: v.skipIf,
    whereItWins: v.whereItWins,
    whereItLoses: v.whereItLoses,
    watchSetup: v.watchSetup,
  }));
  
  return {
    pillar: "Sat Verdict",
    weekendDates,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    hotTake: output.hotTake,
    verdicts,
    releases,
  };
}