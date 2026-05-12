// src/content/weekend/wednesday-drop.ts
import { format, parseISO } from "date-fns";
import { callClaudeJSON } from "../claude.js";
import { log } from "../../shared/logger.js";
import type { Release } from "../../shared/types.js";
import type { WednesdayDropDraft } from "../../delivery/notion.js";

interface LLMOutput {
  caption: string;
  hashtags: string[];
  carouselSlides: {
    slideNumber: number;
    type: "cover" | "index" | "release" | "cta";
    title: string;
    body: string;
  }[];
}

/**
 * Format a release for the LLM in a compact, structured way.
 */
function releaseForPrompt(r: Release): string {
  const lines = [
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
  ];
  return lines.join("\n");
}

/**
 * Generate a Wednesday Drop draft from a list of releases.
 */
export async function generateWednesdayDrop(
  releases: Release[],
  weekendStart: string,
  weekendEnd: string
): Promise<WednesdayDropDraft> {
  if (releases.length === 0) {
    throw new Error("Cannot generate Wednesday Drop with zero releases");
  }
  
  const weekendDates = `${format(parseISO(weekendStart), "MMM d")} — ${format(parseISO(weekendEnd), "MMM d, yyyy")}`;
  
  log.info(`Generating Wednesday Drop for ${weekendDates} (${releases.length} releases)`);
  
  const releaseBlocks = releases.map((r, i) => `--- RELEASE ${i + 1} ---\n${releaseForPrompt(r)}`).join("\n\n");
  
  const prompt = `You are the head social media strategist for a Pan-Indian OTT + film industry Instagram page.

PAGE IDENTITY:
- Niche: Indian OTT weekend release decision-maker + always-on film industry pulse
- Coverage: Hindi, Telugu, Tamil, Malayalam, Kannada, Marathi, Bengali cinema + Indian content on international platforms
- Positioning: We don't just LIST releases. We help people DECIDE what to watch.
- Differentiation: Verdicts (not just hype), mood tags, family filter, regional depth, OTT movement tracking.

TONE & VOICE:
- English-first with light Hinglish sprinkled naturally ("must-watch", "binge-worthy", "skip kar do", "weekend sorted", "kya scene hai")
- Confident and opinionated — we take stands, not safe hedges
- Conversational, like a friend texting recommendations
- Hook-first: open with curiosity, contrast, or a strong claim
- South-heavy: when 2+ languages compete, lean into the South where the action is
- Never generic. Never "Here are the releases this week." Always specific.

OUTPUT RULES:
- Never use AI-cliche phrases ("dive into", "delve", "in today's fast-paced world", "buckle up", "look no further")
- Caption: under 150 words, opens with a hook, closes with a CTA
- 10-12 hashtags mixing broad + niche + platform + language
- South-Indian films get equal-or-greater attention than Hindi when they're stronger

TASK: Generate a Wednesday "The Drop" Instagram carousel post for this weekend.

WEEKEND: ${weekendDates}

THIS WEEKEND'S RELEASES (${releases.length} total):

${releaseBlocks}

DELIVERABLES (respond as JSON):

{
  "caption": "Instagram caption text under 150 words. Opens with a hook, mentions the biggest drop, the hidden gem, the regional spotlight if any, closes with 'Save this' / 'DM us' / 'Which one are you watching?' CTA.",
  "hashtags": ["array", "of", "10-12", "hashtags", "with", "the", "# prefix"],
  "carouselSlides": [
    { "slideNumber": 1, "type": "cover", "title": "<6-word headline>", "body": "<10-word subtext>" },
    { "slideNumber": 2, "type": "index", "title": "This weekend", "body": "<quick visual list: Title (Language) → Platform>" },
    { "slideNumber": 3, "type": "release", "title": "<film title>", "body": "<one-line WHY this matters — not a synopsis, a reason to care>" },
    ...one slide per release up to slide 9...
    { "slideNumber": N, "type": "cta", "title": "<short CTA>", "body": "<which one are you starting with?>" }
  ]
}

Be specific. Take stands. Lean South-heavy where the films justify it.`;
  
  const output = await callClaudeJSON<LLMOutput>(prompt);
  
  // Render carousel slides as markdown for the Notion body
  const carouselSlides = output.carouselSlides
    .map(s => `**Slide ${s.slideNumber}** (${s.type}): **${s.title}** — ${s.body}`)
    .join("\n\n");
  
  return {
    pillar: "Wed Drop",
    weekendDates,
    caption: output.caption,
    hashtags: output.hashtags.join(" "),
    carouselSlides,
    releases,
  };
}