// src/content/weekend/monday-movement.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { MovementDraft } from "../../delivery/notion.js";

interface LLMOutput {
  weekHeadline: string;
  caption: string;
  hashtags: string[];
  carouselSlides: {
    slideNumber: number;
    type: "cover" | "headline" | "arrival" | "gem" | "cta";
    title: string;
    body: string;
  }[];
}

function releaseForPrompt(r: Release, isArrival: boolean): string {
  return [
    `[${isArrival ? "NEW ARRIVAL" : "HIDDEN GEM"}] ${r.title} (${r.language})`,
    `  Released: ${r.releaseDate}`,
    `  Platform: ${r.platform.length ? r.platform.join(", ") : "TBA"}`,
    `  Director: ${r.director ?? "—"}`,
    `  Cast: ${r.cast.slice(0, 3).join(", ") || "—"}`,
    `  Genres: ${r.genre.join(", ") || "—"}`,
    r.imdbRating ? `  IMDb: ${r.imdbRating} (${r.imdbVotes ?? 0} votes)` : "",
    `  Synopsis: ${r.synopsis.slice(0, 200)}${r.synopsis.length > 200 ? "..." : ""}`,
  ].filter(Boolean).join("\n");
}

export async function generateMondayMovement(
  newArrivals: Release[],
  hiddenGems: Release[],
  weekStart: string,
  weekEnd: string
): Promise<MovementDraft> {
  if (newArrivals.length === 0 && hiddenGems.length === 0) {
    throw new Error("Cannot generate Movement post with zero films");
  }
  
  const weekLabel = `Week of ${format(parseISO(weekStart), "MMM d")} — ${format(parseISO(weekEnd), "MMM d, yyyy")}`;
  log.info(`Generating Monday Movement: ${weekLabel} (${newArrivals.length} arrivals, ${hiddenGems.length} gems)`);
  
  const arrivalsBlock = newArrivals.length > 0
    ? newArrivals.map(r => releaseForPrompt(r, true)).join("\n\n")
    : "(no confirmed new OTT arrivals from TMDb this week — likely a quiet week or platforms didn't surface their adds)";
  
  const gemsBlock = hiddenGems.map(r => releaseForPrompt(r, false)).join("\n\n");
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page. Monday is the OTT MOVEMENT post — what changed across the Indian streaming landscape this week.

PAGE IDENTITY:
- Pan-Indian, South-heavy. We track every platform, every language.
- Confident, opinionated, conversational. Light Hinglish where natural.
- Decision page, not info page — but Monday is the most "report" of our pillars, so leans observational.

CRITICAL TONE RULES:
- Don't just list films. Find the PATTERN. The post's spine is one line: what does this week's movement say about Indian OTT right now?
- Be specific. Name platforms, name languages, call out trends.
- Acknowledge gaps. If no Tamil arrivals dropped, say so — "Tamil OTT is quiet this week."
- NEVER use AI-cliche phrases: "dive into", "delve", "in today's fast-paced world", "buckle up", "look no further", "landscape" (overused), "elevates".

WEEK: ${weekLabel}

NEW OTT ARRIVALS (last 7 days):
${arrivalsBlock}

HIDDEN GEMS WORTH SURFACING:
${gemsBlock}

DELIVERABLES (respond as JSON):

{
  "weekHeadline": "ONE bold line. The post's spine. Pattern-recognition statement about what this week's movement reveals. e.g., 'Three Malayalam thrillers landed this week and not one Hindi drama. Mollywood is running the genre clock.'",
  "caption": "Under 140 words. Open with the weekHeadline or a variant. Walk through 2-3 specific arrivals with one-line takes. Mention 1-2 hidden gems. End with CTA: 'Save this. DM us if you've watched any.'",
  "hashtags": ["10-12 hashtags array with # prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline based on weekHeadline>", "body": "<short subtext>" },
    { "slideNumber": 2, "type": "headline", "title": "This week in OTT", "body": "<the weekHeadline expanded to 2 sentences>" },
    { "slideNumber": 3, "type": "arrival", "title": "<film title>", "body": "<one-line why this matters — platform, language, genre angle>" },
    ...one slide per arrival up to 4 arrivals max...
    { "slideNumber": N, "type": "gem", "title": "Hidden Gem: <film>", "body": "<why this is worth pulling up from your watch list>" },
    ...up to 2 gem slides...
    { "slideNumber": N+1, "type": "cta", "title": "<CTA>", "body": "Save. DM us. Which one are you starting?" }
  ]
}

IMPORTANT:
- The weekHeadline is the most important line in the entire post. Make it specific, opinionated, and pattern-aware.
- Don't dilute. If there's only 1 great arrival, lead with it and don't pad with weak ones.
- Hidden gems should feel like "you missed this and you shouldn't have" — not just "another good film."`;
  
  const output = await callClaudeJSON<LLMOutput>(prompt, "sonnet");
  
  const carouselSlides = output.carouselSlides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");
  
  return {
    pillar: "Mon Movement",
    weekLabel,
    weekHeadline: output.weekHeadline,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    slides: output.carouselSlides,
    carouselSlides,
    newArrivals,
    hiddenGems,
  };
}